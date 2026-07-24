import { z } from "zod";
import { gidSchema } from "../schemas";

export const AUDIT_EVENT_SCHEMA = "asana-cli.audit-event.v2" as const;
export const AUDIT_EVENT_FILE_FORMAT_VERSION = 2 as const;

const hashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const timestampSchema = z.iso.datetime({ offset: true });

export const auditActionSchema = z.enum([
  "task.update",
  "task.comment",
  "task.create",
  "task.project.add",
  "task.project.remove",
  "task.section.move",
  "task.dependency.add",
  "task.dependency.remove",
]);
export const auditFailureClassSchema = z.enum([
  "policy_denied",
  "validation",
  "conflict",
  "stale",
  "expired",
  "unknown_result",
  "network",
  "asana_api",
  "storage",
]);

export const auditResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("prepared") }),
  z.strictObject({ outcome: z.literal("applying") }),
  z.strictObject({
    outcome: z.literal("applied"),
    resource_gid: gidSchema.optional(),
    resource_modified_at: timestampSchema.optional(),
  }),
  z.strictObject({
    outcome: z.literal("unknown"),
    failure_class: auditFailureClassSchema.optional(),
  }),
  z.strictObject({ outcome: z.literal("expired") }),
  z.strictObject({
    outcome: z.literal("denied"),
    failure_class: z.literal("policy_denied"),
  }),
]);

export const auditTargetSchema = z.union([
  z.strictObject({
    kind: z.literal("task"),
    task_gid: gidSchema,
  }),
  z.strictObject({
    kind: z.literal("task-create"),
    workspace_gid: gidSchema,
    project_gid: gidSchema,
    parent_task_gid: gidSchema.optional(),
  }),
]);

export const createMetadataAuditEventInputSchema = z.strictObject({
  operation_id: z.uuid(),
  target: auditTargetSchema,
  action: auditActionSchema,
  plan_hash: hashSchema,
  record_hash: hashSchema,
  result: auditResultSchema,
});

export const metadataAuditEventSchema = z.strictObject({
  schema: z.literal(AUDIT_EVENT_SCHEMA),
  file_format_version: z.literal(AUDIT_EVENT_FILE_FORMAT_VERSION),
  event_id: z.uuid(),
  occurred_at: timestampSchema,
  ...createMetadataAuditEventInputSchema.shape,
});

export type CreateMetadataAuditEventInput = z.input<typeof createMetadataAuditEventInputSchema>;
export type MetadataAuditEvent = z.output<typeof metadataAuditEventSchema>;

/**
 * The only persisted fields are explicitly enumerated above. In particular, task names,
 * write payloads, comment text, credentials, headers, and raw responses/errors have no schema path.
 */
export function createMetadataAuditEvent(
  inputValue: CreateMetadataAuditEventInput,
  now: Date,
  eventId: string,
): MetadataAuditEvent {
  const input = createMetadataAuditEventInputSchema.parse(inputValue);
  return metadataAuditEventSchema.parse({
    schema: AUDIT_EVENT_SCHEMA,
    file_format_version: AUDIT_EVENT_FILE_FORMAT_VERSION,
    event_id: z.uuid().parse(eventId),
    occurred_at: z.date().parse(now).toISOString(),
    ...input,
  });
}

export function cloneMetadataAuditEvent(event: MetadataAuditEvent): MetadataAuditEvent {
  return metadataAuditEventSchema.parse(structuredClone(event));
}
