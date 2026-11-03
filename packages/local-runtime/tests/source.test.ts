import { expect, test } from 'bun:test';
import { createAsanaTransport } from '@asana-cli/asana-client';
import { createTaskSource } from '../src/source';
test('SDK Events API handles initial/expired sync and rejects permission errors',async()=>{
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){
  const url=new URL(request.url);
  if(url.searchParams.get('resource')==='999')return Response.json({errors:[{message:'Denied'}]},{status:403});
  if(!url.searchParams.get('sync'))return Response.json({sync:'first'},{status:412});
  return Response.json({sync:'next',data:[{action:'changed'}],has_more:false});
 }});
 try{
  const source=createTaskSource(createAsanaTransport('FIXTURE_TOKEN',{baseUrl:new URL('/api/1.0',server.url).toString()}));
  expect(await source.events('111')).toEqual({sync:'first',changed:true,more:false});
  expect(await source.events('111','first')).toEqual({sync:'next',changed:true,more:false});
  await expect(source.events('999')).rejects.toThrow();
 }finally{server.stop(true);}
});
