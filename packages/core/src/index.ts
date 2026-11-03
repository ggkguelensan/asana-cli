import { z } from 'zod';

export const trackingRuleSchema = z.strictObject({
  preset: z.enum(['current_work', 'all_incomplete', 'custom']).default('current_work'),
  choices: z.array(z.string().min(1).max(256)).max(100).default([]),
});
export type TrackingRule = z.infer<typeof trackingRuleSchema>;
export const taskSchema = z.object({
  gid: z.string(), name: z.string().default(''), completed: z.boolean().default(false),
  modified_at: z.string().optional(), permalink_url: z.string().optional(),
  workspace: z.object({gid:z.string()}).optional(),
  memberships: z.array(z.object({project:z.object({gid:z.string(),name:z.string().default('')}),section:z.object({gid:z.string(),name:z.string().default('')}).optional()})).default([]),
  custom_fields: z.array(z.object({gid:z.string(),name:z.string().default(''),enum_value:z.object({gid:z.string(),name:z.string()}).nullable().optional()})).default([]),
  dependencies: z.array(z.object({gid:z.string(),name:z.string().optional()})).default([]),
});
export type SourceTask = z.infer<typeof taskSchema>;
export interface Choice { id: string; label: string; group: string; count: number }
export function taskChoices(task: SourceTask): Choice[] {
  const sections = task.memberships.flatMap((m) => m.section ? [{id:`section:${m.section.gid}`,label:m.section.name,group:m.project.name,count:1}] : []);
  const fields = task.custom_fields.flatMap((f) => f.enum_value ? [{id:`enum:${f.gid}:${f.enum_value.gid}`,label:f.enum_value.name,group:f.name,count:1}] : []);
  return [...sections, ...fields];
}
const activeSections = new Set(['todo','inprogress','codereview']);
export function normalizedStage(name: string): string { return name.toLowerCase().replace(/[\s_-]/g,''); }
function isCurrentSection(choice: Choice): boolean {
  return choice.id.startsWith('section:') && activeSections.has(normalizedStage(choice.label));
}
export function selectedTask(task: SourceTask, rule: TrackingRule): boolean {
  if (task.completed) return false;
  if (rule.preset === 'all_incomplete') return true;
  const choices = taskChoices(task);
  if (rule.preset === 'current_work') return choices.some(isCurrentSection);
  return choices.some((choice) => rule.choices.includes(choice.id));
}
export function choiceInventory(tasks: readonly SourceTask[]): Choice[] {
  const result = new Map<string, Choice>();
  for (const choice of tasks.flatMap(taskChoices)) {
    const existing = result.get(choice.id);
    result.set(choice.id, {...choice,count:(existing?.count ?? 0)+1});
  }
  return [...result.values()].sort((a,b)=>`${a.group}/${a.label}`.localeCompare(`${b.group}/${b.label}`));
}
/** Owners, not tabs' duplicated task lists, determine provider interest. */
export class InterestRegistry {
  private owners = new Map<string, {resources:Set<string>; expires:number}>();
  set(owner: string, resources: readonly string[], expires = Infinity): void {
    this.owners.set(owner,{resources:new Set(resources),expires});
  }
  owns(owner:string,resource:string):boolean {return this.owners.get(owner)?.resources.has(resource)??false;}
  has(owner:string):boolean {return this.owners.has(owner);}
  release(owner: string): void { this.owners.delete(owner); }
  expire(now: number): void {
    for (const [owner,entry] of this.owners) if (entry.expires <= now) this.release(owner);
  }
  resources(): string[] { return [...new Set([...this.owners.values()].flatMap((entry)=>[...entry.resources]))]; }
  count(resource: string): number { return [...this.owners.values()].filter((entry)=>entry.resources.has(resource)).length; }
  snapshot() { return [...this.owners].map(([owner,entry])=>({owner,resources:[...entry.resources]})); }
}

const taskId=z.string().regex(/^\d{1,32}$/);
export const viewWatchSchema=z.discriminatedUnion('type',[
  z.object({type:z.literal('watch.graph'),root:taskId}),
  z.object({type:z.literal('watch.tasks'),resources:z.array(taskId).max(50)}),
  z.object({type:z.literal('heartbeat')}),
]);
export type ViewWatch=z.infer<typeof viewWatchSchema>;
