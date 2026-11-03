import { z } from 'zod';
import { trackingRuleSchema, type TrackingRule } from '@asana-cli/core';
const choice=z.object({id:z.string(),label:z.string(),group:z.string(),count:z.number()});
export const trackingStatusSchema=z.object({state:z.string(),user:z.string().optional(),candidates:z.number(),tracked:z.number(),truncated:z.boolean(),rule:trackingRuleSchema,choices:z.array(choice),csrf_token:z.string(),subscriptions:z.object({resources:z.number(),event_responses:z.number(),event_changes:z.number(),synced:z.number(),retrying:z.number(),owners:z.array(z.object({owner:z.string(),count:z.number()}))})});
export type TrackingStatus=z.infer<typeof trackingStatusSchema>;
export async function loadTracking(signal?:AbortSignal):Promise<TrackingStatus>{
  const response=await fetch('/api/v1/tracking',{credentials:'same-origin',signal});
  if(!response.ok)throw new Error('Service connection required');return trackingStatusSchema.parse(await response.json());
}
export async function saveTracking(rule:TrackingRule,csrf:string):Promise<void>{
  const response=await fetch('/api/v1/tracking',{method:'PUT',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(trackingRuleSchema.parse(rule))});
  if(!response.ok)throw new Error('Could not save tracking settings');
}
export async function exchangeBrowserSession():Promise<void>{
  const fragment=new URLSearchParams(window.location.hash.slice(1));const code=fragment.get('bootstrap');
  if(!code)return;
  history.replaceState(null,'',window.location.pathname+window.location.search);
  const response=await fetch('/api/v1/session/exchange',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});
  if(!response.ok)throw new Error('Browser connection expired; run asana-cli-next board open');
}
const graph=z.object({type:z.literal('graph.snapshot'),root:z.string(),nodes:z.array(z.object({id:z.string(),title:z.string(),completed:z.boolean()})).max(36),edges:z.array(z.object({from:z.string(),to:z.string()})).max(3600),truncated:z.boolean(),resources:z.array(z.string()).max(36)});
export type DependencyGraph=z.infer<typeof graph>;
interface ViewStream {send(message:unknown):void;close():void}
function openViewStream(initial:unknown,onMessage:(value:unknown)=>void,onState:(state:string)=>void):ViewStream {
  const url=new URL('/api/v1/views/events',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';
  const socket=new WebSocket(url);let disposed=false;
  function send(message:unknown){if(disposed)return;if(socket.readyState===1)socket.send(JSON.stringify(message));}
  const timer=setInterval(()=>send({type:'heartbeat'}),10_000);
  socket.onopen=()=>{if(disposed)return;onState('Подключено');send(initial);};
  socket.onmessage=event=>{if(disposed)return;try{onMessage(JSON.parse(String(event.data)) as unknown);}catch{socket.close(1008);onState('Несовместимый ответ');}};
  socket.onclose=()=>{clearInterval(timer);if(!disposed)onState('Соединение закрыто — обновите страницу');};
  const close=()=>{disposed=true;clearInterval(timer);socket.close();window.removeEventListener('pagehide',close);};
  window.addEventListener('pagehide',close);return {send,close};
}
export function watchDependencyGraph(root:string,handlers:{snapshot(graph:DependencyGraph):void;state(value:string):void}):()=>void {
  let pending=true;let dirty=false;
  const message={type:'watch.graph',root};
  function request(){if(pending){dirty=true;return;}pending=true;stream.send(message);}
  function accept(value:DependencyGraph){pending=false;handlers.snapshot(value);if(dirty){dirty=false;request();}}
  function other(value:unknown){const type=z.object({type:z.string()}).parse(value).type;if(type==='board.invalidated')request();else{pending=false;handlers.state('Не удалось обновить граф');}}
  const stream=openViewStream(message,value=>{const result=graph.safeParse(value);if(result.success)accept(result.data);else other(value);},handlers.state);
  return stream.close;
}
/** Reusable source-view lease; closing/unmounting releases only this owner. */
export function watchTasks(resources:readonly string[],onInvalidate:()=>void):()=>void {
  return openViewStream({type:'watch.tasks',resources},value=>{
    const message=z.object({type:z.string()}).parse(value);
    if(['board.invalidated','watch.ready'].includes(message.type))onInvalidate();
  },()=>{}).close;
}
