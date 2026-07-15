import { z } from "zod";
import {
  operationIsExpired,
  operationNameSchema,
  operationStateSchema,
  type OperationRecord,
} from "./schemas";

const timestampSchema = z.iso.datetime({ offset: true });

const statusTargetSchema = z.strictObject({
  task_gid: z.string().regex(/^\d{1,64}$/),
});

const statusResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("applied"),
    recorded_at: timestampSchema,
    resource_gid: z.string().regex(/^\d{1,64}$/).optional(),
    resource_modified_at: z.string().min(1).max(128).optional(),
  }),
  z.strictObject({
    outcome: z.literal("unknown"),
    recorded_at: timestampSchema,
    request_may_have_succeeded: z.literal(true),
    error_code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(),
  }),
  z.strictObject({
    outcome: z.literal("expired"),
    recorded_at: timestampSchema,
  }),
]);

export const operationStatusNextStepSchema = z.enum([
  "apply-with-explicit-approval",
  "prepare-a-new-operation",
  "wait-for-existing-attempt",
  "inspect-asana-and-obtain-human-direction",
  "no-action-required",
]);

export const operationStatusProjectionSchema = z.strictObject({
  operation_id: z.uuid(),
  operation: operationNameSchema,
  state: operationStateSchema,
  target: statusTargetSchema,
  created_at: timestampSchema,
  expires_at: timestampSchema,
  is_expired: z.boolean(),
  attempt_started_at: timestampSchema.optional(),
  result: statusResultSchema.optional(),
  next_step: operationStatusNextStepSchema,
});

export type OperationStatusProjection = z.output<typeof operationStatusProjectionSchema>;

function statusResultProjection(record: OperationRecord): z.output<typeof statusResultSchema> | undefined {
  const result = record.result;
  if (!result) return undefined;
  if (result.outcome === "applied") {
    return {
      outcome: result.outcome,
      recorded_at: result.recorded_at,
      ...(result.resource_gid === undefined ? {} : { resource_gid: result.resource_gid }),
      ...(result.resource_modified_at === undefined
        ? {}
        : { resource_modified_at: result.resource_modified_at }),
    };
  }
  if (result.outcome === "unknown") {
    return {
      outcome: result.outcome,
      recorded_at: result.recorded_at,
      request_may_have_succeeded: true,
      ...(result.error_code === undefined ? {} : { error_code: result.error_code }),
    };
  }
  return {
    outcome: result.outcome,
    recorded_at: result.recorded_at,
  };
}

function nextStep(record: OperationRecord, isExpired: boolean): z.output<typeof operationStatusNextStepSchema> {
  if (record.state === "prepared") {
    return isExpired ? "prepare-a-new-operation" : "apply-with-explicit-approval";
  }
  if (record.state === "applying") return "wait-for-existing-attempt";
  if (record.state === "unknown") return "inspect-asana-and-obtain-human-direction";
  if (record.state === "expired") return "prepare-a-new-operation";
  return "no-action-required";
}

export function operationStatusProjection(
  record: OperationRecord,
  now: Date = new Date(),
): OperationStatusProjection {
  const checkedNow = z.date().parse(now);
  const isExpired = record.state === "expired" || operationIsExpired(record, checkedNow);
  return operationStatusProjectionSchema.parse({
    operation_id: record.id,
    operation: record.operation,
    state: record.state,
    target: { task_gid: record.target.task_gid },
    created_at: record.created_at,
    expires_at: record.expires_at,
    is_expired: isExpired,
    ...(record.attempt_started_at === undefined
      ? {}
      : { attempt_started_at: record.attempt_started_at }),
    ...(record.result === undefined ? {} : { result: statusResultProjection(record) }),
    next_step: nextStep(record, isExpired),
  });
}
