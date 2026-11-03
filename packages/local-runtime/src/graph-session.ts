import { viewWatchSchema as packet } from '@asana-cli/core';
import type { WSContext } from 'hono/ws';
import type { TrackingEngine } from './engine';
function parsePacket(value:unknown){
  if(typeof value!=='string')return undefined;
  if(value.length>2048)return undefined;
  try{return packet.safeParse(JSON.parse(value) as unknown).data;}catch{return undefined;}
}
export class GraphSession {
  readonly owner=`view:${crypto.randomUUID()}`;
  private resources:string[]=[];
  private active=true;
  private loading=false;
  private binding:string|undefined;
  constructor(private engine:TrackingEngine,private authorized:()=>boolean){}
  interested(resource?:string){return resource===undefined||this.engine.interests.owns(this.owner,resource);}
  close(){this.active=false;this.engine.release(this.owner);}
  async message(value:unknown,ws:WSContext){
    if(!this.authorized()){ws.close(4401);this.close();return;}
    const input=parsePacket(value);if(!input){ws.close(1008);return;}
    await this.dispatch(input,ws);
  }
  private async dispatch(input:import('@asana-cli/core').ViewWatch,ws:WSContext){
    if(input.type==='heartbeat'){this.heartbeat();return;}
    if(!this.bind(input,ws))return;
    if(input.type==='watch.tasks'){this.track(input.resources,ws);return;}
    await this.draw(input.root,ws);
  }
  private bind(input:unknown,ws:WSContext){const signature=JSON.stringify(input);if(this.binding&&this.binding!==signature){this.close();ws.close(1008);return false;}this.binding=signature;return true;}
  private heartbeat(){if(this.resources.length===0)return;if(this.active)this.engine.interests.set(this.owner,this.resources,Date.now()+45_000);}
  private track(resources:string[],ws:WSContext){this.resources=[...new Set(resources)];if(this.resources.length===0)this.engine.release(this.owner);this.heartbeat();this.send(ws,{type:'watch.ready',resources:this.resources});}
  private send(ws:WSContext,value:unknown){if(!this.active)return;try{ws.send(JSON.stringify(value));}catch{this.close();}}
  private accept(ws:WSContext,graph:Awaited<ReturnType<TrackingEngine['graph']>>){
    if(!this.active){this.engine.release(this.owner);return;}
    this.resources=graph.resources;this.send(ws,{type:'graph.snapshot',...graph});
  }
  private async draw(root:string,ws:WSContext){
    if(this.loading)return;this.loading=true;
    try{this.accept(ws,await this.engine.graph(root,this.owner));}
    catch{this.engine.release(this.owner);this.send(ws,{type:'graph.error'});}
    finally{this.loading=false;}
  }
}
