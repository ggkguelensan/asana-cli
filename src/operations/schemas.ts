import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  expandedTaskCreateFieldsSchema,
  taskCreateTemplateMetadataSchema,
  taskPatchSchema,
} from "../agent-action-schemas";
import { AGENT_PROTOCOL_VERSION } from "../version";

export const OPERATION_FILE_FORMAT_VERSION = 1 as const;
export const OPERATION_RECORD_SCHEMA = "asana-cli.operation.v1" as const;
export const DEFAULT_OPERATION_TTL_MS = 30 * 60 * 1_000;
export const MAX_OPERATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

const gidSchema = z.string().regex(/^\d{1,64}$/, "must be a numeric Asana GID");
const hashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const timestampSchema = z.iso.datetime({ offset: true });

export const operationStateSchema = z.enum([
  "prepared",
  "applying",
  "applied",
  "unknown",
  "expired",
]);

export const operationNameSchema = z.enum(["task.update", "task.comment", "task.create"]);

const existingTaskOperationTargetSchema = z.strictObject({
  task_gid: gidSchema,
});

const taskCreateOperationTargetSchema = z.strictObject({
  workspace_gid: gidSchema,
  project_gid: gidSchema,
  parent_task_gid: gidSchema.optional(),
});

export const operationTargetSchema = z.union([
  existingTaskOperationTargetSchema,
  taskCreateOperationTargetSchema,
]);

const existingTaskOperationGuardsSchema = z.strictObject({
  expected_modified_at: timestampSchema,
  prepared_by_gid: gidSchema,
});

const taskCreateOperationGuardsSchema = z.strictObject({
  prepared_by_gid: gidSchema,
  expected_parent_modified_at: timestampSchema.optional(),
});

export const operationGuardsSchema = z.union([
  existingTaskOperationGuardsSchema,
  taskCreateOperationGuardsSchema,
]);

const taskUpdatePayloadSchema = z.strictObject({
  changes: taskPatchSchema,
});

const taskCommentPayloadSchema = z.strictObject({
  text: z.string().min(1).max(8_000),
});

const taskCreatePayloadSchema = z.strictObject({
  fields: expandedTaskCreateFieldsSchema,
  template: taskCreateTemplateMetadataSchema.optional(),
});

const appliedResultSchema = z.strictObject({
  outcome: z.literal("applied"),
  recorded_at: timestampSchema,
  resource_gid: gidSchema.optional(),
  resource_modified_at: z.string().min(1).max(128).optional(),
});

const unknownResultSchema = z.strictObject({
  outcome: z.literal("unknown"),
  recorded_at: timestampSchema,
  request_may_have_succeeded: z.literal(true),
  error_code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(),
});

const expiredResultSchema = z.strictObject({
  outcome: z.literal("expired"),
  recorded_at: timestampSchema,
});

export const operationResultSchema = z.discriminatedUnion("outcome", [
  appliedResultSchema,
  unknownResultSchema,
  expiredResultSchema,
]);

const recordBaseShape = {
  schema: z.literal(OPERATION_RECORD_SCHEMA),
  file_format_version: z.literal(OPERATION_FILE_FORMAT_VERSION),
  agent_protocol_version: z.literal(AGENT_PROTOCOL_VERSION),
  id: z.uuid(),
  state: operationStateSchema,
  created_at: timestampSchema,
  expires_at: timestampSchema,
  attempt_started_at: timestampSchema.optional(),
  plan_hash: hashSchema,
  record_hash: hashSchema,
  result: operationResultSchema.optional(),
};

const taskUpdateRecordSchema = z.strictObject({
  ...recordBaseShape,
  operation: z.literal("task.update"),
  target: existingTaskOperationTargetSchema,
  guards: existingTaskOperationGuardsSchema,
  payload: taskUpdatePayloadSchema,
});

const taskCommentRecordSchema = z.strictObject({
  ...recordBaseShape,
  operation: z.literal("task.comment"),
  target: existingTaskOperationTargetSchema,
  guards: existingTaskOperationGuardsSchema,
  payload: taskCommentPayloadSchema,
});

const taskCreateRecordSchema = z.strictObject({
  ...recordBaseShape,
  operation: z.literal("task.create"),
  target: taskCreateOperationTargetSchema,
  guards: taskCreateOperationGuardsSchema,
  payload: taskCreatePayloadSchema,
}).superRefine((record, context) => {
  const hasParent = record.target.parent_task_gid !== undefined;
  const hasParentGuard = record.guards.expected_parent_modified_at !== undefined;
  if (hasParent !== hasParentGuard) {
    context.addIssue({
      code: "custom",
      path: ["guards", "expected_parent_modified_at"],
      message: "subtask creation requires an exact parent concurrency guard",
    });
  }
});

export const operationRecordFileSchema = z.discriminatedUnion("operation", [
  taskUpdateRecordSchema,
  taskCommentRecordSchema,
  taskCreateRecordSchema,
]).superRefine((record, context) => {
  const createdAt = Date.parse(record.created_at);
  const expiresAt = Date.parse(record.expires_at);
  if (expiresAt <= createdAt) {
    context.addIssue({
      code: "custom",
      path: ["expires_at"],
      message: "expires_at must be later than created_at",
    });
  }

  if (record.state === "prepared" || record.state === "applying") {
    if (record.result !== undefined) {
      context.addIssue({ code: "custom", path: ["result"], message: "active states cannot have a result" });
    }
  } else if (record.result?.outcome !== record.state) {
    context.addIssue({
      code: "custom",
      path: ["result"],
      message: `state ${record.state} requires matching result metadata`,
    });
  }

  const attemptStarted = record.attempt_started_at !== undefined;
  const requiresAttempt = record.state === "applying" || record.state === "applied" || record.state === "unknown";
  if (attemptStarted !== requiresAttempt) {
    context.addIssue({
      code: "custom",
      path: ["attempt_started_at"],
      message: requiresAttempt
        ? `state ${record.state} requires attempt_started_at`
        : `state ${record.state} cannot have attempt_started_at`,
    });
  }
});

const createBaseShape = {
  ttl_ms: z.number().int().positive().max(MAX_OPERATION_TTL_MS).default(DEFAULT_OPERATION_TTL_MS),
};

export const createOperationInputSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    ...createBaseShape,
    operation: z.literal("task.update"),
    target: existingTaskOperationTargetSchema,
    guards: existingTaskOperationGuardsSchema,
    payload: taskUpdatePayloadSchema,
  }),
  z.strictObject({
    ...createBaseShape,
    operation: z.literal("task.comment"),
    target: existingTaskOperationTargetSchema,
    guards: existingTaskOperationGuardsSchema,
    payload: taskCommentPayloadSchema,
  }),
  z.strictObject({
    ...createBaseShape,
    operation: z.literal("task.create"),
    target: taskCreateOperationTargetSchema,
    guards: taskCreateOperationGuardsSchema,
    payload: taskCreatePayloadSchema,
  }).superRefine((record, context) => {
    const hasParent = record.target.parent_task_gid !== undefined;
    const hasParentGuard = record.guards.expected_parent_modified_at !== undefined;
    if (hasParent !== hasParentGuard) {
      context.addIssue({
        code: "custom",
        path: ["guards", "expected_parent_modified_at"],
        message: "subtask creation requires an exact parent concurrency guard",
      });
    }
  }),
]);

const appliedTransitionMetadataSchema = z.strictObject({
  resource_gid: gidSchema.optional(),
  resource_modified_at: z.string().min(1).max(128).optional(),
});

const unknownTransitionMetadataSchema = z.strictObject({
  error_code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(),
});

export const operationTransitionSchema = z.discriminatedUnion("next_state", [
  z.strictObject({
    id: z.uuid(),
    expected_state: z.literal("prepared"),
    next_state: z.literal("applying"),
  }),
  z.strictObject({
    id: z.uuid(),
    expected_state: z.literal("applying"),
    next_state: z.literal("prepared"),
  }),
  z.strictObject({
    id: z.uuid(),
    expected_state: z.literal("prepared"),
    next_state: z.literal("expired"),
  }),
  z.strictObject({
    id: z.uuid(),
    expected_state: z.literal("applying"),
    next_state: z.literal("applied"),
    metadata: appliedTransitionMetadataSchema.optional(),
  }),
  z.strictObject({
    id: z.uuid(),
    expected_state: z.literal("applying"),
    next_state: z.literal("unknown"),
    metadata: unknownTransitionMetadataSchema.optional(),
  }),
]);

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type OperationState = z.output<typeof operationStateSchema>;
export type OperationName = z.output<typeof operationNameSchema>;
export type OperationRecord = DeepReadonly<z.output<typeof operationRecordFileSchema>>;
export type CreateOperationInput = DeepReadonly<z.input<typeof createOperationInputSchema>>;
export type OperationTransition = DeepReadonly<z.input<typeof operationTransitionSchema>>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot hash a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const object = z.record(z.string(), z.unknown()).parse(value);
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  throw new Error("Cannot hash a non-JSON value");
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function planHashInput(record: OperationRecord): unknown {
  return {
    schema: record.schema,
    file_format_version: record.file_format_version,
    agent_protocol_version: record.agent_protocol_version,
    id: record.id,
    operation: record.operation,
    target: record.target,
    payload: record.payload,
    guards: record.guards,
    created_at: record.created_at,
    expires_at: record.expires_at,
  };
}

function recordHashInput(record: OperationRecord): unknown {
  return {
    schema: record.schema,
    file_format_version: record.file_format_version,
    agent_protocol_version: record.agent_protocol_version,
    id: record.id,
    operation: record.operation,
    state: record.state,
    target: record.target,
    payload: record.payload,
    guards: record.guards,
    created_at: record.created_at,
    expires_at: record.expires_at,
    attempt_started_at: record.attempt_started_at,
    plan_hash: record.plan_hash,
    result: record.result,
  };
}

export function computeOperationPlanHash(record: OperationRecord): string {
  return sha256(planHashInput(record));
}

export function computeOperationRecordHash(record: OperationRecord): string {
  return sha256(recordHashInput(record));
}

export function parseOperationRecord(value: unknown): OperationRecord {
  const record = operationRecordFileSchema.parse(value);
  if (record.plan_hash !== computeOperationPlanHash(record)) {
    throw new Error("Operation plan hash mismatch");
  }
  if (record.record_hash !== computeOperationRecordHash(record)) {
    throw new Error("Operation record hash mismatch");
  }
  return record;
}

export function cloneOperationRecord(record: OperationRecord): OperationRecord {
  return parseOperationRecord(structuredClone(record));
}

export function createOperationRecord(
  inputValue: CreateOperationInput,
  now: Date,
  id: string = randomUUID(),
): OperationRecord {
  const input = createOperationInputSchema.parse(inputValue);
  const parsedId = z.uuid().parse(id);
  const createdAt = z.date().parse(now);
  const createdAtIso = createdAt.toISOString();
  const expiresAtIso = new Date(createdAt.getTime() + input.ttl_ms).toISOString();
  const unsigned = {
    schema: OPERATION_RECORD_SCHEMA,
    file_format_version: OPERATION_FILE_FORMAT_VERSION,
    agent_protocol_version: AGENT_PROTOCOL_VERSION,
    id: parsedId,
    operation: input.operation,
    state: "prepared" as const,
    target: input.target,
    payload: input.payload,
    guards: input.guards,
    created_at: createdAtIso,
    expires_at: expiresAtIso,
    plan_hash: "sha256:" + "0".repeat(64),
    record_hash: "sha256:" + "0".repeat(64),
  };
  const structural = operationRecordFileSchema.parse(unsigned);
  const withPlanHash = { ...structural, plan_hash: computeOperationPlanHash(structural) };
  return parseOperationRecord({
    ...withPlanHash,
    record_hash: computeOperationRecordHash(withPlanHash),
  });
}

export function transitionOperationRecord(
  record: OperationRecord,
  transitionValue: OperationTransition,
  now: Date,
): OperationRecord {
  const transition = operationTransitionSchema.parse(transitionValue);
  const recordedAt = z.date().parse(now).toISOString();
  if (transition.id !== record.id) throw new Error("Operation transition ID mismatch");
  if (transition.expected_state !== record.state) throw new Error("Operation state changed");

  let result: z.output<typeof operationResultSchema> | undefined;
  const attemptStartedAt = transition.next_state === "applying"
    ? recordedAt
    : transition.next_state === "prepared"
      ? undefined
      : record.attempt_started_at;
  if (transition.next_state === "applied") {
    result = { outcome: "applied", recorded_at: recordedAt, ...transition.metadata };
  } else if (transition.next_state === "unknown") {
    result = {
      outcome: "unknown",
      recorded_at: recordedAt,
      request_may_have_succeeded: true,
      ...transition.metadata,
    };
  } else if (transition.next_state === "expired") {
    result = { outcome: "expired", recorded_at: recordedAt };
  }

  const changed = operationRecordFileSchema.parse({
    ...record,
    state: transition.next_state,
    attempt_started_at: attemptStartedAt,
    result,
    record_hash: "sha256:" + "0".repeat(64),
  });
  return parseOperationRecord({ ...changed, record_hash: computeOperationRecordHash(changed) });
}

export function operationIsExpired(record: OperationRecord, now: Date): boolean {
  const checkedNow = z.date().parse(now);
  return record.state === "prepared" && Date.parse(record.expires_at) <= checkedNow.getTime();
}
