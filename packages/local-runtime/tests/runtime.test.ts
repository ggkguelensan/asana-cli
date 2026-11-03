import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { taskSchema } from '@asana-cli/core';
import { runService, TrackingEngine, type TaskSource } from '../src';
const task=(gid:string,deps:string[]=[])=>taskSchema.parse({gid,name:`Task ${gid}`,memberships:[{project:{gid:'9',name:'Fixture'},section:{gid:'8',name:gid==='111'?'In Progress':'Backlog'}}],dependencies:deps.map(gid=>({gid}))});
function source():TaskSource{return {identity:async()=>({gid:'1',name:'Fixture',workspaces:[{gid:'2',name:'Workspace'}]}),assigned:async()=>({tasks:[task('111',['222'])],truncated:false}),task:async gid=>task(gid,gid==='111'?['222']:[]),events:async()=>({sync:'s',changed:false,more:false})};}

test('local service authenticates browser, enforces CSRF and persists tracking rule across restart',async()=>{
 const root=await mkdtemp(join(tmpdir(),'asana-next-runtime-'));const options={stateDirectory:root,pat:'FIXTURE_TOKEN',source:source()};
 const service=await runService(options);const url=service.descriptor.origin;
 const headers={Authorization:`Bearer ${service.descriptor.nativeToken}`};
 try {
  expect((await fetch(`${url}/api/v1/board`)).status).toBe(401);
  expect((await fetch(`${url}/api/v1/status`,{headers:{...headers,Origin:'https://untrusted.invalid'}})).status).toBe(403);
  const boot=await fetch(`${url}/api/v1/session/bootstrap`,{method:'POST',headers});const value=await boot.json() as {code:string};
  const exchange=()=>fetch(`${url}/api/v1/session/exchange`,{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:JSON.stringify(value)});
  const session=await exchange();expect(session.status).toBe(200);expect((await exchange()).status).toBe(403);
  const cookie=session.headers.get('set-cookie')!.split(';')[0]!;
  await service.engine.refresh();
  const state=await fetch(`${url}/api/v1/tracking`,{headers:{Cookie:cookie}}).then(r=>r.json()) as {csrf_token:string;tracked:number};
  expect(state.tracked).toBe(1);
  const rule={preset:'all_incomplete',choices:[]};
  expect((await fetch(`${url}/api/v1/tracking`,{method:'PUT',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(rule)})).status).toBe(403);
  expect((await fetch(`${url}/api/v1/tracking`,{method:'PUT',headers:{Cookie:cookie,'X-CSRF-Token':state.csrf_token,'Content-Type':'application/json'},body:JSON.stringify(rule)})).status).toBe(200);
  await service.stop();
  const restarted=await runService(options);try{expect(restarted.engine.rule.preset).toBe('all_incomplete');}finally{await restarted.stop();}
 }finally{await service.stop();await rm(root,{recursive:true,force:true});}
});
test('closing a real view websocket releases dependency interest without losing the background task',async()=>{
 const root=await mkdtemp(join(tmpdir(),'asana-next-lease-'));const service=await runService({stateDirectory:root,pat:'FIXTURE',source:source()});
 try{
  await service.engine.refresh();
  const Socket=WebSocket as unknown as {new(url:string,options:{headers:Record<string,string>}):WebSocket};
  const ws=new Socket(service.descriptor.origin.replace('http:','ws:')+'/api/v1/views/events',{headers:{Authorization:`Bearer ${service.descriptor.nativeToken}`}});
  await new Promise<void>((resolve,reject)=>{ws.onopen=()=>ws.send(JSON.stringify({type:'watch.graph',root:'111'}));ws.onerror=reject;ws.onmessage=e=>{if(JSON.parse(String(e.data)).type==='graph.snapshot')resolve();};});
  expect(service.engine.interests.count('111')).toBe(2);expect(service.engine.interests.count('222')).toBe(1);
  ws.close();await Bun.sleep(30);
  expect(service.engine.interests.resources()).toEqual(['111']);
 }finally{await service.stop();await rm(root,{recursive:true,force:true});}
});
test('a graph closed during its source request cannot resurrect the lease',async()=>{
 let resolveTask:(value:ReturnType<typeof task>)=>void=()=>{};
 const delayed=new Promise<ReturnType<typeof task>>(resolve=>{resolveTask=resolve;});
 const provider=source();provider.task=()=>delayed;
 const engine=new TrackingEngine(provider,{});const pending=engine.graph('111','view:test');
 engine.release('view:test');resolveTask(task('111'));
 await expect(pending).rejects.toThrow('lease_closed');expect(engine.interests.resources()).toEqual([]);
});

test('generic task view has a real independent lease and unknown protocol closes safely',async()=>{
 const root=await mkdtemp(join(tmpdir(),'asana-next-generic-'));const service=await runService({stateDirectory:root,pat:'FIXTURE',source:source()});
 try{
  await service.engine.refresh();
  const Socket=WebSocket as unknown as {new(url:string,options:{headers:Record<string,string>}):WebSocket};
  const ws=new Socket(service.descriptor.origin.replace('http:','ws:')+'/api/v1/views/events',{headers:{Authorization:`Bearer ${service.descriptor.nativeToken}`}});
  await new Promise<void>((resolve,reject)=>{ws.onerror=reject;ws.onopen=()=>ws.send(JSON.stringify({type:'watch.tasks',resources:['222']}));ws.onmessage=e=>{if(JSON.parse(String(e.data)).type==='watch.ready')resolve();};});
  expect(service.engine.interests.resources().sort()).toEqual(['111','222']);
  const closed=new Promise<void>(resolve=>{ws.onclose=()=>resolve();});ws.send('malformed');await closed;
  expect(service.engine.interests.resources()).toEqual(['111']);
 }finally{await service.stop();await rm(root,{recursive:true,force:true});}
});
