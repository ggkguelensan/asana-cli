import { Hono, type Context } from 'hono';
import { GraphSession } from './graph-session';
import { upgradeWebSocket, websocket } from 'hono/bun';
import { bodyLimit } from 'hono/body-limit';
import type { WSContext } from 'hono/ws';
import { z } from 'zod';
import { join, extname } from 'node:path';
import { writeFile, rename, rm } from 'node:fs/promises';
import { createAsanaTransport } from '@asana-cli/asana-client';
import { trackingRuleSchema } from '@asana-cli/core';
import { commandSchema } from '@asana-cli/contracts';
import { createTaskSource, type TaskSource } from './source';
import { TrackingEngine } from './engine';
import { openStore } from './store';
import { Sessions, sameSecret } from './security';
import { embeddedAssets } from './assets';

export { TrackingEngine } from './engine';
export { type TaskSource } from './source';
export const discoverySchema=z.object({instance:z.string(),origin:z.string().regex(/^http:\/\/127\.0\.0\.1:\d{1,5}$/),nativeToken:z.string(),pid:z.number(),channel:z.literal('next'),protocol:z.literal(1)});
export interface ServiceOptions {stateDirectory:string;pat:string;source?:TaskSource;assetDirectory?:string;port?:number;onStop?:()=>Promise<void>}
function contentType(path:string):string {return ({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'} as Record<string,string>)[extname(path)]??'application/octet-stream';}
export async function runService(options:ServiceOptions){
  const store=openStore(options.stateDirectory);
  const source=options.source??createTaskSource(createAsanaTransport(options.pat,{timeoutMs:10_000}));
  const engine=new TrackingEngine(source,store.rule());
  const user=await source.identity();store.bindAccount(user.gid);
  const sessions=new Sessions();const nativeToken=crypto.randomUUID();const instance=crypto.randomUUID();
  const clients=new Map<unknown,{ws:WSContext;authorized:()=>boolean;interested:(resource?:string)=>boolean}>();let origin='';let closed=false;
  const app=new Hono();
  app.use('*',bodyLimit({maxSize:16_384}));
  app.onError(()=>new Response(JSON.stringify({error:'request_failed'}),{status:503,headers:{'Content-Type':'application/json'}}));
  function readSession(c:Context){return sessions.read(c.req.header('Cookie')??'');}
  function isNative(c:Context){return sameSecret(c.req.header('Authorization'),`Bearer ${nativeToken}`);}
  function unrestricted(c:Context){return isNative(c)||c.req.path==='/api/v1/session/exchange';}
  function validOrigin(c:Context){
    if(new URL(c.req.url).origin!==origin)return false;
    const value=c.req.header('Origin');return !value||value===origin;
  }
  function browserFailure(c:Context){
    const session=readSession(c);if(!session)return 401;
    if(c.req.method==='GET')return undefined;
    return sameSecret(c.req.header('X-CSRF-Token'),session.csrf)?undefined:403;
  }
  app.use('/api/*',async(c,next)=>{
    if(!validOrigin(c))return c.json({error:'invalid_origin'},403);
    if(unrestricted(c)){await next();return;}
    const failure=browserFailure(c);if(failure)return c.json({error:'session_or_csrf_required'},failure);
    await next();
  });
  app.post('/api/v1/session/bootstrap',c=>{
    if(!sameSecret(c.req.header('Authorization'),`Bearer ${nativeToken}`))return c.json({error:'owner_required'},403);
    return c.json({code:sessions.issue()});
  });
  app.post('/api/v1/session/exchange',async c=>{
    if(c.req.header('Origin')!==origin)return c.json({error:'invalid_origin'},403);
    const input=z.object({code:z.string().max(100)}).parse(await c.req.json());
    const id=sessions.exchange(input.code);
    if(!id)return c.json({error:'invalid_code'},403);
    c.header('Set-Cookie',`asana_next=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
    return c.json({connected:true});
  });
  app.get('/api/v1/capabilities',c=>c.json({channel:'next',protocol:1,features:['my-work.select','task.metadata.read','task.events.watch','dependency_graph.read','view.lease'],asana_mutations:false,lease_ttl_ms:45000,graph_limits:{depth:3,per_level:12},events:{mode:'asana_events_api',global_interval_ms:2000,minimum_resource_interval_ms:30000}}));
  app.get('/api/v1/status',c=>c.json({instance,channel:'next',protocol:1,...engine.status()}));
  app.get('/api/v1/tracking',c=>{
    const csrf=sessions.read(c.req.header('Cookie')??'')?.csrf??'native';
    return c.json({...engine.status(),csrf_token:csrf});
  });
  app.put('/api/v1/tracking',async c=>{
    const rule=trackingRuleSchema.parse(await c.req.json());store.saveRule(rule);engine.configure(rule);
    return c.json({saved:true});
  });
  app.get('/api/v1/tasks/:gid',async c=>{const gid=z.string().regex(/^\d{1,32}$/).parse(c.req.param('gid'));return c.json(await engine.readTask(gid));});
  app.get('/api/v1/board',c=>c.json(engine.board(instance,sessions.read(c.req.header('Cookie')??'')?.csrf??'native')));
  app.get('/api/v1/events',upgradeWebSocket(c=>({
    onOpen:(_,ws)=>{clients.set(ws.raw,{ws,authorized:()=>isNative(c)||Boolean(readSession(c)),interested:resource=>resource===undefined||engine.selected.some(t=>t.gid===resource)});},onClose:(_,ws)=>{clients.delete(ws.raw);},
  })));
  app.get('/api/v1/views/events',upgradeWebSocket(c=>{
    const session=new GraphSession(engine,()=>isNative(c)||Boolean(readSession(c)));
    return {
      onOpen:(_,ws)=>{clients.set(ws.raw,{ws,authorized:()=>isNative(c)||Boolean(readSession(c)),interested:resource=>session.interested(resource)});},
      onMessage:(event,ws)=>session.message(event.data,ws),
      onClose:(_,ws)=>{clients.delete(ws.raw);session.close();},
    };
  }));
  const stop=async()=>{
    if(closed)return;closed=true;engine.stop();
    for(const {ws} of clients.values()){ws.send(JSON.stringify({type:'service.stopping'}));ws.close();}
    server.stop(true);store.close();await rm(join(options.stateDirectory,'service.json'),{force:true});await options.onStop?.();
  };
  app.post('/api/v1/commands',async c=>{
    const command=commandSchema.parse(await c.req.json());
    if(command.kind==='refresh_sources')await engine.refresh();
    else if(command.kind==='service_stop'){store.stop();setTimeout(()=>void stop(),100);}
    else return c.json({error:'unsupported_capability'},422);
    return c.json({request_id:command.request_id,status:'completed'});
  });
  function safePath(path:string){return !path.includes('..')&&/^\/[\w./-]+$/.test(path);}
  async function diskAsset(path:string){
    if(!options.assetDirectory)return new Response('Build the web application first',{status:503});
    if(!safePath(path))return new Response('Not found',{status:404});
    const file=Bun.file(join(options.assetDirectory,path));
    if(!await file.exists())return new Response('Not found',{status:404});
    return new Response(file,{headers:{'Content-Type':contentType(path),'Cache-Control':'no-store'}});
  }
  app.get('*',async c=>{
    const path=c.req.path==='/'?'/index.html':c.req.path;
    const embedded=embeddedAssets[path];
    c.header('X-Content-Type-Options','nosniff');c.header('Referrer-Policy','no-referrer');c.header('Cache-Control','no-store');
    if(embedded)return c.body(embedded.body,200,{'Content-Type':embedded.type});
    return diskAsset(path);
  });
  const server=Bun.serve({hostname:'127.0.0.1',port:options.port??0,fetch:app.fetch,websocket});
  origin=`http://127.0.0.1:${server.port}`;
  function deliver(client:typeof clients extends Map<unknown,infer T>?T:never,resource?:string){
    if(!client.authorized()){client.ws.close(4401);return;}
    if(!client.interested(resource))return;
    try{client.ws.send(JSON.stringify({type:'board.invalidated',cursor:String(engine.revision)}));}
    catch{clients.delete(client.ws.raw);}
  }
  engine.onChange=resource=>{for(const client of clients.values())deliver(client,resource);};
  const descriptor={instance,origin,nativeToken,pid:process.pid,channel:'next' as const,protocol:1 as const};
  const temporary=join(options.stateDirectory,`${instance}.json`);
  await writeFile(temporary,JSON.stringify(descriptor),{mode:0o600});await rename(temporary,join(options.stateDirectory,'service.json'));
  engine.start();
  return {descriptor,engine,stop,server};
}
