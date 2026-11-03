import { z } from 'zod';
import { taskSchema, type SourceTask } from '@asana-cli/core';
import type { AsanaTransport } from '@asana-cli/asana-client';

const fields = 'gid,name,completed,modified_at,permalink_url,workspace.gid,memberships.project.gid,memberships.project.name,memberships.section.gid,memberships.section.name,custom_fields.gid,custom_fields.name,custom_fields.enum_value.gid,custom_fields.enum_value.name,dependencies.gid';
const collection = z.looseObject({data:z.array(z.unknown()),nextPage:z.custom<()=>Promise<unknown>>((v)=>typeof v==='function').optional(),_response:z.looseObject({next_page:z.unknown().optional()}).optional()});
const identity = z.object({data:z.object({gid:z.string(),name:z.string(),workspaces:z.array(z.object({gid:z.string(),name:z.string()}))})});
export type Identity = z.infer<typeof identity>['data'];
const eventPage = z.looseObject({sync:z.string(),data:z.array(z.unknown()),has_more:z.boolean().optional()});
export interface TaskSource {
  identity():Promise<Identity>;
  assigned(user:Identity):Promise<{tasks:SourceTask[];truncated:boolean}>;
  task(gid:string):Promise<SourceTask>;
  events(gid:string,sync?:string):Promise<{sync:string;changed:boolean;more:boolean}>;
}
function responseBody(error: unknown): unknown {
  return z.looseObject({response:z.looseObject({status:z.literal(412),body:z.unknown()})}).safeParse(error).data?.response.body;
}
async function nextPage(page:z.infer<typeof collection>,index:number){if(index===4)return undefined;if(!page.nextPage)return undefined;return collection.parse(await page.nextPage());}
function hasMore(page:z.infer<typeof collection>){return Boolean(page._response?.next_page);}
async function readPages(value:unknown):Promise<{tasks:SourceTask[];truncated:boolean}> {
  const tasks:SourceTask[]=[]; let page=collection.parse(value);
  for(let index=0;index<5;index++) {
    tasks.push(...z.array(taskSchema).parse(page.data));
    if(!hasMore(page)) return {tasks,truncated:false};
    const next=await nextPage(page,index);if(!next)return {tasks,truncated:true};page=next;
  }
  return {tasks,truncated:true};
}
export function createTaskSource(transport:AsanaTransport):TaskSource {
  return {
    async identity(){return identity.parse(await transport.invoke('UsersApi','getUser',['me',{opt_fields:'gid,name,workspaces.gid,workspaces.name'}])).data;},
    async assigned(user){
      const pages=await Promise.all(user.workspaces.map(async(workspace)=>readPages(await transport.invoke('TasksApi','getTasks',[{assignee:user.gid,workspace:workspace.gid,completed_since:'now',limit:100,opt_fields:fields}]))));
      return {tasks:pages.flatMap(p=>p.tasks),truncated:pages.some(p=>p.truncated)};
    },
    async task(gid){return z.object({data:taskSchema}).parse(await transport.invoke('TasksApi','getTask',[gid,{opt_fields:fields}])).data;},
    async events(gid,sync){
      let value:unknown;
      try { value=await transport.invoke('EventsApi','getEvents',[gid,{sync}]); }
      catch(error){ const page=z.object({sync:z.string()}).safeParse(responseBody(error)); if(!page.success)throw error; return {sync:page.data.sync,changed:true,more:false}; }
      const direct=eventPage.safeParse(value);
      const page=direct.success?direct.data:z.object({_response:eventPage}).parse(value)._response;
      return {sync:page.sync,changed:page.data.length>0,more:page.has_more===true};
    },
  };
}
