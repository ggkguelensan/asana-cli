import { collectGraph } from './graph';
import { InterestRegistry, selectedTask, trackingRuleSchema, choiceInventory, taskChoices, normalizedStage, type SourceTask, type TrackingRule } from '@asana-cli/core';
import type { TaskSource, Identity } from './source';

export class TrackingEngine {
  readonly interests=new InterestRegistry();
  readonly tasks=new Map<string,SourceTask>();
  readonly eventState=new Map<string,{sync?:string;at:number;status:string}>();
  user:Identity|undefined;
  candidates:SourceTask[]=[];
  selected:SourceTask[]=[];
  rule:TrackingRule;
  state='connecting';
  fetchedAt=new Date().toISOString();
  truncated=false;
  eventResponses=0;
  eventChanges=0;
  revision=1;
  onChange: (resource?:string)=>void=()=>{};
  onTask: (task:SourceTask)=>void=()=>{};
  onTick: ()=>void=()=>{};
  private stopped=false;
  private timer:ReturnType<typeof setInterval>|undefined;
  private busy=false;
  private refreshing:Promise<void>|undefined;
  private discoveryAt=0;
  constructor(readonly source:TaskSource, rule:unknown){this.rule=trackingRuleSchema.parse(rule);}
  async refresh():Promise<void> {
    if(this.refreshing)return this.refreshing;
    this.refreshing=this.discover().finally(()=>{this.refreshing=undefined;});
    return this.refreshing;
  }
  private async discover():Promise<void> {
    try {
      this.user=await this.source.identity();
      const result=await this.source.assigned(this.user);
      this.candidates=result.tasks; this.truncated=result.truncated;
      for(const task of result.tasks)this.tasks.set(task.gid,task);
      if(this.stopped)return;
      result.tasks.forEach(task=>this.onTask(task));
      this.reselect(); this.state='connected'; this.fetchedAt=new Date().toISOString();
    } catch {this.state='asana_unavailable';}
    this.discoveryAt=Date.now(); this.notify();
  }
  private reselect():void {
    this.selected=this.candidates.filter(task=>selectedTask(task,this.rule));
    this.interests.set('background:my-work',this.selected.map(t=>t.gid));
    this.prune();
  }
  configure(rule:TrackingRule):void {this.rule=rule;this.reselect();this.notify();}
  notify(resource?:string):void {this.revision++;this.onChange(resource);}
  start():void { this.timer=setInterval(()=>void this.tick(),2000); void this.refresh(); }
  stop():void {this.stopped=true;clearInterval(this.timer);this.timer=undefined;this.interests.snapshot().forEach(entry=>this.release(entry.owner));}
  private prune():void {
    const live=new Set(this.interests.resources());
    this.pruneMap(this.eventState,live);this.pruneMap(this.tasks,live);
  }
  private pruneMap<T>(map:Map<string,T>,live:Set<string>){for(const gid of map.keys())if(!live.has(gid))map.delete(gid);}
  release(owner:string):void {this.interests.release(owner);this.prune();}
  async tick():Promise<void> {
    if(this.busy)return;
    this.busy=true;
    try{await this.work();}finally{this.busy=false;}
  }
  private async work():Promise<void> {
    if(this.stopped)return;
    this.onTick();this.interests.expire(Date.now());this.prune();
    if(Date.now()-this.discoveryAt>60_000)await this.refresh();
    const gid=this.nextResource();
    if(gid)await this.poll(gid);
  }
  private at(gid:string):number {return this.eventState.get(gid)?.at??0;}
  private nextResource():string|undefined {return this.interests.resources().sort((a,b)=>this.at(a)-this.at(b)).find(gid=>Date.now()-this.at(gid)>30_000);}
  private async poll(gid:string):Promise<void> {
    const previous=this.eventState.get(gid);
    try {
      const result=await this.source.events(gid,previous?.sync);
      await this.acceptEvents(gid,result);
    } catch {this.retry(gid,previous);}
  }
  private retry(gid:string,previous:{sync?:string;at:number;status:string}|undefined){
    if(this.interests.count(gid))this.eventState.set(gid,{...previous,at:Date.now(),status:'retrying'});
  }
  private async acceptEvents(gid:string,result:Awaited<ReturnType<TaskSource['events']>>){
    if(!this.interests.count(gid))return;
    this.eventResponses++;
    this.eventState.set(gid,{sync:result.sync,at:result.more?Date.now()-30_001:Date.now(),status:'synced'});
    if(result.changed){this.eventChanges++;await this.update(gid);}
  }
  private async update(gid:string):Promise<void> {
    const task=await this.source.task(gid);
    if(!this.interests.count(gid))return;
    this.tasks.set(gid,task);this.onTask(task);
    this.candidates=this.candidates.map(t=>t.gid===gid?task:t);
    this.reselect();this.fetchedAt=new Date().toISOString();this.notify(gid);
  }
  status(){return {state:this.state,user:this.user?.name,candidates:this.candidates.length,tracked:this.selected.length,truncated:this.truncated,rule:this.rule,choices:choiceInventory(this.candidates),updated_at:this.fetchedAt,subscriptions:{resources:this.interests.resources().length,owners:this.interests.snapshot().map(o=>({owner:o.owner,count:o.resources.length})),event_responses:this.eventResponses,event_changes:this.eventChanges,synced:[...this.eventState.values()].filter(s=>s.status==='synced').length,retrying:[...this.eventState.values()].filter(s=>s.status==='retrying').length}};}
  board(instance:string,csrf:string){return {schema:'asana-cli.board.v1' as const,cursor:String(this.revision),instance_id:instance,workspace:this.user?.workspaces.map(w=>w.name).join(', ')??'Asana',fetched_at:this.fetchedAt,csrf_token:csrf,capabilities:{track:false,refresh:true,stop:true},items:this.selected.slice(0,100).map(task=>this.item(task))};}
  private item(task:SourceTask){return {id:task.gid,revision:this.revision,key:`#${task.gid.slice(-6)}`,kind:'task' as const,title:task.name,status:this.displayStatus(task),asana_url:`https://app.asana.com/0/0/${task.gid}`,owner:this.user?.name??'Я',next:taskChoices(task).filter(c=>c.id.startsWith('section:')).map(c=>`${c.group}: ${c.label}`).join(' · ').slice(0,4000),source:this.state==='connected'?'fresh' as const:'stale' as const,updated_at:this.fetchedAt,changes:[],actions:[]};}
  private displayStatus(task:SourceTask):'work'|'review' {return taskChoices(task).some(c=>normalizedStage(c.label)==='codereview')?'review':'work';}
  async readTask(gid:string):Promise<SourceTask>{
    const cached=this.tasks.get(gid);if(cached)return cached;
    const task=await this.source.task(gid);if(this.interests.count(gid))this.tasks.set(gid,task);return task;
  }
  async graph(root:string,owner:string){return collectGraph(root,owner,this.interests,gid=>this.readTask(gid));}
}
