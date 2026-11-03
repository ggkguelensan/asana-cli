import type { InterestRegistry, SourceTask } from '@asana-cli/core';
export async function collectGraph(root:string,owner:string,interests:InterestRegistry,read:(gid:string)=>Promise<SourceTask>){
  const nodes=new Map<string,SourceTask>();const edges:{from:string;to:string}[]=[];
  let pending=[root];let limited=false;
  const old=ownerResources(interests,owner);
  interests.set(owner,[...old,root],Date.now()+45_000);
  function assertLive(){if(!interests.has(owner))throw new Error('lease_closed');}
  function add(task:SourceTask){nodes.set(task.gid,task);edges.push(...task.dependencies.map(d=>({from:task.gid,to:d.gid})));}
  async function level(){
    limited=limited||pending.length>12;
    const tasks=await Promise.all(pending.slice(0,12).map(read));assertLive();tasks.forEach(add);
    pending=[...new Set(tasks.flatMap(t=>t.dependencies.map(d=>d.gid)))].filter(gid=>!nodes.has(gid));
    interests.set(owner,[...old,...nodes.keys(),...pending.slice(0,12)],Date.now()+45_000);
  }
  for(let depth=0;depth<3;depth++){await level();if(pending.length===0)break;}
  assertLive();interests.set(owner,[...nodes.keys()],Date.now()+45_000);
  return {root,nodes:[...nodes.values()].map(t=>({id:t.gid,title:t.name,completed:t.completed})),edges,truncated:limited||pending.length>0,resources:[...nodes.keys()]};
}

function ownerResources(interests:InterestRegistry,owner:string){return interests.snapshot().find(entry=>entry.owner===owner)?.resources??[];}
