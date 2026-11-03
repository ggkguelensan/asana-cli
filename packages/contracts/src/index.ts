import { z } from "zod";

const text = z.string().max(4000);
const id = z.string().min(1).max(128);
const httpsUrl = z.url().max(2048).refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password;
});

export const workStatuses = ['wait_user', 'blocked', 'review', 'work', 'wait_others', 'reviewing', 'merged', 'done'] as const;
export type WorkStatus = typeof workStatuses[number];
const statusSchema = z.enum(workStatuses);
const actionKindSchema = z.enum(['resolve_request', 'complete_work', 'reopen_work']);

const actionSchema = z.strictObject({
  id, kind: actionKindSchema, label: z.string().min(1).max(100),
  enabled: z.boolean(), reason: text.optional(), request_id: id.optional(),
});
export type WorkAction = z.infer<typeof actionSchema>;

const changeSchema = z.strictObject({
  id, label: z.string().max(100), url: httpsUrl.optional(),
  ci: z.enum(['success', 'failed', 'running', 'unknown']),
  approvals: z.string().max(100).optional(), merged: z.boolean(),
});
export type ChangeRef = z.infer<typeof changeSchema>;

const itemSchema = z.strictObject({
  id, revision: z.number().int().positive(), key: z.string().max(100),
  kind: z.enum(['task', 'review']), title: z.string().max(500).nullable(),
  status: statusSchema, asana_url: httpsUrl.optional(),
  owner: z.string().max(200), waiting: text.optional(), next: text.optional(),
  source: z.enum(['fresh', 'stale', 'unknown']),
  updated_at: z.iso.datetime(), changes: z.array(changeSchema).max(20),
  actions: z.array(actionSchema).max(10),
  session: z.strictObject({ name: z.string().max(200), online: z.boolean() }).optional(),
});
export type WorkItem = z.infer<typeof itemSchema>;

export const boardSchema = z.strictObject({
  schema: z.literal('asana-cli.board.v1'), cursor: id, instance_id: id,
  workspace: z.string().max(200), fetched_at: z.iso.datetime(),
  csrf_token: z.string().min(1).max(256),
  capabilities: z.strictObject({ track: z.boolean(), refresh: z.boolean(), stop: z.boolean() }),
  items: z.array(itemSchema).max(100),
}).refine((value) => new Set(value.items.map((item) => item.id)).size === value.items.length,
  'Work item IDs must be unique');
export type BoardSnapshot = z.infer<typeof boardSchema>;

export const eventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('board.invalidated'), cursor: id }),
  z.strictObject({ type: z.literal('resync_required') }),
  z.strictObject({ type: z.literal('service.stopping') }),
]);
export type BoardEvent = z.infer<typeof eventSchema>;

export const commandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ request_id: z.uuid(), kind: actionKindSchema,
    work_item_id: id, expected_revision: z.number().int().positive(),
    action_id: id, target_request_id: id.optional() }),
  z.strictObject({ request_id: z.uuid(), kind: z.literal('track'),
    task_gid: z.string().regex(/^\d{1,32}$/) }),
  z.strictObject({ request_id: z.uuid(), kind: z.enum(['refresh_sources', 'service_stop']) }),
]);
export type BoardCommand = z.infer<typeof commandSchema>;

export const receiptSchema = z.strictObject({
  request_id: z.uuid(),
  status: z.enum(['queued', 'accepted', 'completed', 'failed', 'unknown']),
});
export type CommandReceipt = z.infer<typeof receiptSchema>;
