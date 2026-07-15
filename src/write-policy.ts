import { z } from "zod";
import { taskPatchSchema } from "./agent-action-schemas";
import { gidSchema } from "./schemas";

export const SCOPED_WRITE_POLICY_SCHEMA = "asana-cli.scoped-write-policy.v1" as const;

export const taskUpdateWriteFieldSchema = z.enum([
  "name",
  "notes",
  "completed",
  "assignee",
  "due_on",
  "due_at",
  "start_on",
  "custom_fields",
]);

const uniqueValues = <Value>(values: readonly Value[]): boolean =>
  new Set(values).size === values.length;

const gidAllowlistSchema = z.array(gidSchema).max(1_000).refine(uniqueValues, "allowlist values must be unique");

const scopedWritePolicyScopeSchema = z.strictObject({
  workspace_gid: gidSchema,
  project_gids: gidAllowlistSchema,
  task_update_fields: z.array(taskUpdateWriteFieldSchema)
    .max(taskUpdateWriteFieldSchema.options.length)
    .refine(uniqueValues, "write fields must be unique"),
  custom_field_gids: gidAllowlistSchema,
  allow_comments: z.boolean(),
}).superRefine((scope, context) => {
  const customFieldsAllowed = scope.task_update_fields.includes("custom_fields");
  if (customFieldsAllowed !== (scope.custom_field_gids.length > 0)) {
    context.addIssue({
      code: "custom",
      path: ["custom_field_gids"],
      message: customFieldsAllowed
        ? "custom_field_gids must be non-empty when custom_fields is allowed"
        : "custom_field_gids must be empty when custom_fields is not allowed",
    });
  }
});

export const scopedWritePolicySchema = z.strictObject({
  schema: z.literal(SCOPED_WRITE_POLICY_SCHEMA),
  scopes: z.array(scopedWritePolicyScopeSchema).min(1).max(100).refine(
    (scopes) => uniqueValues(scopes.map((scope) => scope.workspace_gid)),
    "workspace scopes must be unique",
  ),
});

export type ScopedWritePolicy = z.output<typeof scopedWritePolicySchema>;

/**
 * Parses a policy supplied by the host's trusted configuration loader.
 * This module deliberately has no argv, stdin, environment, or journal reader.
 */
export function parseHostScopedWritePolicy(value: unknown): ScopedWritePolicy {
  return scopedWritePolicySchema.parse(value);
}

const writeTargetScopeSchema = z.strictObject({
  workspace_gid: gidSchema,
  project_gids: z.array(gidSchema).min(1).max(1_000).refine(
    uniqueValues,
    "project identifiers must be unique",
  ),
});

const taskUpdateWriteCandidateSchema = z.strictObject({
  action: z.literal("task.update"),
  target: writeTargetScopeSchema,
  write_fields: z.array(taskUpdateWriteFieldSchema)
    .min(1)
    .max(taskUpdateWriteFieldSchema.options.length)
    .refine(uniqueValues, "write fields must be unique"),
  custom_field_gids: z.array(gidSchema).max(50).refine(
    uniqueValues,
    "custom field identifiers must be unique",
  ),
}).superRefine((candidate, context) => {
  const hasCustomFields = candidate.write_fields.includes("custom_fields");
  if (hasCustomFields !== (candidate.custom_field_gids.length > 0)) {
    context.addIssue({
      code: "custom",
      path: ["custom_field_gids"],
      message: hasCustomFields
        ? "custom_field_gids must describe every custom field write"
        : "custom_field_gids must be empty without a custom_fields write",
    });
  }
});

const taskCommentWriteCandidateSchema = z.strictObject({
  action: z.literal("task.comment"),
  target: writeTargetScopeSchema,
});

export const scopedWriteCandidateSchema = z.discriminatedUnion("action", [
  taskUpdateWriteCandidateSchema,
  taskCommentWriteCandidateSchema,
]);

export type ScopedWriteCandidate = z.output<typeof scopedWriteCandidateSchema>;

export const scopedWritePolicyDenialSchema = z.enum([
  "invalid_policy",
  "invalid_candidate",
  "workspace_not_allowed",
  "project_not_allowed",
  "write_field_not_allowed",
  "custom_field_not_allowed",
  "comments_not_allowed",
]);

export const scopedWritePolicyDecisionSchema = z.discriminatedUnion("allowed", [
  z.strictObject({ allowed: z.literal(true) }),
  z.strictObject({ allowed: z.literal(false), reason: scopedWritePolicyDenialSchema }),
]);

export type ScopedWritePolicyDecision = z.output<typeof scopedWritePolicyDecisionSchema>;

function deny(reason: z.output<typeof scopedWritePolicyDenialSchema>): ScopedWritePolicyDecision {
  return { allowed: false, reason };
}

/**
 * Produces metadata only: callers may derive it from an already validated request,
 * but no patch value is retained or accepted by policy evaluation.
 */
export function describeTaskUpdateWrite(targetValue: unknown, patchValue: unknown): ScopedWriteCandidate {
  const target = writeTargetScopeSchema.parse(targetValue);
  const patch = taskPatchSchema.parse(patchValue);
  const writeFields = Object.keys(patch).filter((field) => field !== "custom_fields");
  const customFieldGids = patch.custom_fields ? Object.keys(patch.custom_fields) : [];
  if (customFieldGids.length > 0) writeFields.push("custom_fields");

  return taskUpdateWriteCandidateSchema.parse({
    action: "task.update",
    target,
    write_fields: writeFields,
    custom_field_gids: customFieldGids,
  });
}

/** Creates metadata for a comment write without accepting comment text. */
export function describeTaskCommentWrite(targetValue: unknown): ScopedWriteCandidate {
  return taskCommentWriteCandidateSchema.parse({
    action: "task.comment",
    target: writeTargetScopeSchema.parse(targetValue),
  });
}

/**
 * Evaluates only a parsed host policy and metadata-only write candidate. Any malformed
 * policy or candidate is denied; there is no permissive fallback.
 */
export function evaluateScopedWritePolicy(
  policyValue: unknown,
  candidateValue: unknown,
): ScopedWritePolicyDecision {
  const parsedPolicy = scopedWritePolicySchema.safeParse(policyValue);
  if (!parsedPolicy.success) return deny("invalid_policy");

  const parsedCandidate = scopedWriteCandidateSchema.safeParse(candidateValue);
  if (!parsedCandidate.success) return deny("invalid_candidate");

  const candidate = parsedCandidate.data;
  const scope = parsedPolicy.data.scopes.find(
    (entry) => entry.workspace_gid === candidate.target.workspace_gid,
  );
  if (!scope) return deny("workspace_not_allowed");
  if (!candidate.target.project_gids.some((projectGid) => scope.project_gids.includes(projectGid))) {
    return deny("project_not_allowed");
  }

  if (candidate.action === "task.comment") {
    return scope.allow_comments ? { allowed: true } : deny("comments_not_allowed");
  }

  if (!candidate.write_fields.every((field) => scope.task_update_fields.includes(field))) {
    return deny("write_field_not_allowed");
  }
  if (!candidate.custom_field_gids.every((fieldGid) => scope.custom_field_gids.includes(fieldGid))) {
    return deny("custom_field_not_allowed");
  }
  return { allowed: true };
}
