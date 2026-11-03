import { resolve, dirname, join } from 'node:path';
import { mkdir, readFile, open, rm } from 'node:fs/promises';
import { z } from 'zod';
import { runService, discoverySchema } from '@asana-cli/local-runtime';
import { resolveOperationJournalDirectory } from './operations/paths';
import { resolvePatWithSource } from './pat-store';
import { registerSecret } from './security';
import { CliError } from './errors';
import type { ParsedArgs } from './args';

function stateDirectory(){return join(dirname(resolveOperationJournalDirectory()),'next-service');}
async function discovery(){try{return discoverySchema.parse(JSON.parse(await readFile(join(stateDirectory(),'service.json'),'utf8')) as unknown);}catch{return undefined;}}
async function request(path:string,init:RequestInit={}){
  const info=await discovery();if(!info)throw new CliError('validation','Next service is not running');
  const response=await fetch(`${info.origin}${path}`,{...init,signal:AbortSignal.timeout(3000),headers:{Authorization:`Bearer ${info.nativeToken}`,...init.headers}});
  if(!response.ok)throw new CliError('validation',`Next service returned ${response.status}`);
  return z.record(z.string(),z.unknown()).parse(await response.json());
}
async function status(){try{return await request('/api/v1/status');}catch{return undefined;}}
function alive(pid:number):boolean {try{process.kill(pid,0);return true;}catch{return false;}}
async function claim(name:string){
  const directory=stateDirectory();await mkdir(directory,{recursive:true,mode:0o700});const path=join(directory,name);
  try{const handle=await open(path,'wx',0o600);await handle.writeFile(String(process.pid));await handle.close();}
  catch(error){const pid=Number(await readFile(path,'utf8'));if(alive(pid))throw new CliError('validation','A service process is already starting/running');await rm(path);return claim(name);}
  return ()=>rm(path,{force:true});
}
function childEnvironment():Record<string,string>{
  const allowed=['PATH','HOME','USER','LOGNAME','LANG','TMPDIR','XDG_STATE_HOME','XDG_DATA_HOME','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','SSL_CERT_FILE','SSL_CERT_DIR','HTTPS_PROXY','HTTP_PROXY','NO_PROXY'];
  return Object.fromEntries(allowed.flatMap(key=>process.env[key]?[[key,process.env[key]!]]:[]));
}
function selfInvocation():string[]{return import.meta.path.includes('$bunfs')?[process.execPath]:[process.execPath,'run','--no-env-file',resolve(import.meta.dir,'index.ts')];}
async function start(){
  const existing=await status();if(existing)return existing;
  const release=await claim('starting.lock');
  try {
    const again=await status();if(again)return again;
    const credential=await resolvePatWithSource();
    const child=Bun.spawn([...selfInvocation(),'service','run','--bootstrap-stdin'],{cwd:stateDirectory(),env:childEnvironment(),stdin:'pipe',stdout:'ignore',stderr:'ignore',detached:true});
    child.stdin.write(JSON.stringify({pat:credential.pat}));await child.stdin.end();child.unref();
    return waitForStart(child);

  }finally{await release();}
}
async function waitForStart(child:{exitCode:number|null}){
  for(let attempt=0;attempt<100;attempt++){
    const result=await status();if(result)return result;
    if(child.exitCode!==null)throw new CliError('validation','Next service could not start; run service run for diagnostics');
    await Bun.sleep(200);
  }
  throw new CliError('validation','Next service startup timed out; inspect service status before retrying');
}
async function run(args:ParsedArgs){
  const release=await claim('running.lock');
  try{
    const credential=args.flags['bootstrap-stdin']?z.object({pat:z.string().max(8192)}).parse(JSON.parse(await Bun.stdin.text()) as unknown):await resolvePatWithSource();
    registerSecret(credential.pat);
    const service=await runService({stateDirectory:stateDirectory(),pat:credential.pat,onStop:release,assetDirectory:resolve(import.meta.dir,'../../web/dist')});
    const stop=()=>{void service.stop().finally(release);};process.once('SIGTERM',stop);process.once('SIGINT',stop);
    return {channel:'next',url:service.descriptor.origin};
  }catch(error){await release();throw error;}
}
async function openBoard(){
  await start();const info=await discovery();if(!info)throw new CliError('internal','Missing service discovery');
  const code=z.object({code:z.string()}).parse(await request('/api/v1/session/bootstrap',{method:'POST'})).code;
  const child=Bun.spawn([process.platform==='darwin'?'open':'xdg-open',`${info.origin}/#bootstrap=${code}`],{stdout:'ignore',stderr:'ignore'});
  if(await child.exited!==0)throw new CliError('validation','Could not open browser');
  return {channel:'next',url:info.origin,browser_opened:true};
}
async function serviceAction(action:string|undefined,args:ParsedArgs){
  const handlers:Record<string,()=>Promise<unknown>>={
    run:()=>run(args),start,status:async()=>await status()??{state:'stopped',channel:'next'},
    stop:()=>request('/api/v1/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request_id:crypto.randomUUID(),kind:'service_stop'})}),
  };
  const handler=handlers[action??''];
  if(!handler)throw new CliError('usage','Use service start|run|status|stop or board open');
  return handler();
}
async function boardAction(args:ParsedArgs){
  const action=args.positionals[1];
  if(action==='open')return openBoard();
  if(action==='list')return request('/api/v1/board');
  if(action==='sources')return request('/api/v1/tracking');
  throw new CliError('usage','Use board open|list|sources');
}
export async function runServiceCommand(args:ParsedArgs){
  if(args.positionals[0]==='board')return boardAction(args);
  return serviceAction(args.positionals[1],args);
}
