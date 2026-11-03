import { z } from 'zod';
import { taskChoices, type SourceTask } from './index';

const id = z.uuid();
const text = z.string().trim().min(1).max(4000);
export const waitConditionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('completed') }),
  z.strictObject({ kind: z.literal('choice'), choice_id: z.string().regex(/^(section:\d{1,32}|enum:\d{1,32}:\d{1,32})$/) }),
]);
export const checkpointSchema = z.strictObject({
  summary: text, next: text,
  repository: z.string().trim().min(1).max(1024).optional(),
  branch: z.string().trim().min(1).max(256).optional(),
  commit: z.string().regex(/^[a-f0-9]{7,64}$/i).optional(),
});
export const createWorkSchema = z.strictObject({
  request_id: id, task_gid: z.string().regex(/^\d{1,32}$/),
  condition: waitConditionSchema, checkpoint: checkpointSchema,
});
export const workSchema = z.object({
  id, revision: z.number().int().positive(), task_gid: z.string(), title: z.string(),
  status: z.enum(['waiting', 'ready', 'running', 'interrupted', 'completed', 'cancelled']),
  condition: waitConditionSchema, checkpoint: checkpointSchema,
  created_at: z.iso.datetime(), updated_at: z.iso.datetime(),
  evidence: z.object({ observed_at: z.iso.datetime(), modified_at: z.string().optional() }).optional(),
  run: z.object({ worker: z.string(), started_at: z.iso.datetime(), expires_at: z.iso.datetime(), report: z.string().optional() }).optional(),
});
export type Work = z.infer<typeof workSchema>;
export type CreateWork = z.infer<typeof createWorkSchema>;
export const workListSchema = z.object({ items: z.array(workSchema).max(500), lease_ms: z.number() });
const version = { expected_revision: z.number().int().positive() };
const leased = { ...version, lease_token: id };
export const workActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('claim'), ...version, worker: z.string().trim().min(1).max(120), lease_token: id }),
  z.strictObject({ kind: z.literal('heartbeat'), ...leased }),
  z.strictObject({ kind: z.literal('report'), ...leased, summary: text }),
  z.strictObject({ kind: z.literal('complete'), ...leased, summary: text }),
  z.strictObject({ kind: z.literal('cancel'), ...version }),
  z.strictObject({ kind: z.literal('retry'), ...version }),
]);
export type WorkAction = z.infer<typeof workActionSchema>;
export function conditionMet(task: SourceTask, condition: Work['condition']): boolean {
  if (condition.kind === 'completed') return task.completed;
  return taskChoices(task).some(choice => choice.id === condition.choice_id);
}
export function activeWork(work: Work): boolean { return !['completed', 'cancelled'].includes(work.status); }
export class WorkflowError extends Error {
  constructor(readonly code: string, readonly status: 404 | 409 | 422 = 409) { super(code); }
}

export function nextWaitStatus(work: Work, task: SourceTask): Work['status'] {
  if (!['waiting', 'ready'].includes(work.status)) return work.status;
  return conditionMet(task, work.condition) ? 'ready' : 'waiting';
}
