import { z } from "zod";
import { gidSchema } from "./schemas";

const resultLimitSchema = (maximum: number, fallback: number) =>
  z.number().int().min(1).max(maximum).default(fallback);

export const MAX_AGENT_CONTENT_BYTES = 65_536;
export const DEFAULT_AGENT_CONTENT_BYTES = 16_384;

const contentBudgetValueSchema = z.number()
  .int()
  .min(0)
  .max(MAX_AGENT_CONTENT_BYTES);

const contentBudgetSchema = contentBudgetValueSchema.default(DEFAULT_AGENT_CONTENT_BYTES);

export const taskIncludeSelectorSchema = z.enum([
  "notes",
  "html_notes",
  "custom_fields",
  "tags",
  "parent",
  "created_at",
]);

export type TaskIncludeSelector = z.output<typeof taskIncludeSelectorSchema>;
export const TASK_INCLUDE_SELECTORS = taskIncludeSelectorSchema.options;

export const statusInputSchema = z.strictObject({});

export const myTasksInputSchema = z.strictObject({
  workspace_gid: gidSchema.optional(),
  completed: z.enum(["false", "true", "all"]).default("false"),
  limit: resultLimitSchema(100, 50),
  paginate: z.boolean().default(false),
  max_results: resultLimitSchema(500, 100),
});

export const selectedGetTaskInputSchema = z.strictObject({
  task_gid: gidSchema,
  include: z.array(taskIncludeSelectorSchema).max(TASK_INCLUDE_SELECTORS.length).default([]),
  max_content_bytes: contentBudgetSchema,
});

export const legacyGetTaskInputSchema = z.strictObject({
  task_gid: gidSchema,
  include_content: z.boolean().default(false),
  max_content_bytes: contentBudgetValueSchema.optional(),
});

// The second branch preserves the v0.2 stdin contract. Direct flags only produce
// the selector branch and never expose --include-content.
export const getTaskInputSchema = z.union([
  legacyGetTaskInputSchema,
  selectedGetTaskInputSchema,
]);

export const listCommentsInputSchema = z.strictObject({
  task_gid: gidSchema,
  limit: resultLimitSchema(100, 50),
  paginate: z.boolean().default(false),
  max_results: resultLimitSchema(500, 100),
  max_content_bytes: contentBudgetSchema,
});

const searchFields = {
    query: z.string().trim().min(1).max(500),
    workspace_gid: gidSchema.optional(),
    all_assignees: z.boolean().default(false),
    completed: z.boolean().optional(),
};

export const searchInputSchema = z.strictObject({
  ...searchFields,
  max_results: resultLimitSchema(100, 100),
});

export const findGitInputSchema = z.strictObject({
    ...searchFields,
    max_results: resultLimitSchema(500, 100),
    field_gid: gidSchema.optional(),
    contains: z.boolean().default(false),
});

const customFieldValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string()),
]);

const customFieldsPatchSchema = z.record(gidSchema, customFieldValueSchema)
  .refine((fields) => Object.keys(fields).length <= 50, "Too many custom field updates")
  .meta({ maxProperties: 50 });

export const taskPatchSchema = z.strictObject({
  name: z.string().max(500).optional(),
  notes: z.string().max(8_000).optional(),
  completed: z.boolean().optional(),
  assignee: z.literal("me").optional(),
  due_on: z.string().nullable().optional(),
  due_at: z.string().nullable().optional(),
  start_on: z.string().nullable().optional(),
  custom_fields: customFieldsPatchSchema.optional(),
}).refine((patch) => Object.keys(patch).length > 0, "patch must not be empty")
  .refine((patch) => patch.due_on == null || patch.due_at == null, {
    message: "patch cannot set due_on and due_at together",
  })
  .meta({
    minProperties: 1,
    not: {
      required: ["due_on", "due_at"],
      properties: {
        due_on: { type: "string" },
        due_at: { type: "string" },
      },
    },
  });

export const prepareTaskUpdateInputSchema = z.strictObject({
  task_gid: gidSchema,
  patch: taskPatchSchema,
});

const planTargetSchema = z.strictObject({
  gid: gidSchema,
  name: z.string().optional(),
  permalink_url: z.string().optional(),
});

export const taskUpdatePlanSchema = z.strictObject({
  version: z.literal(1),
  operation: z.literal("task.update"),
  task_gid: gidSchema,
  expected_modified_at: z.string().min(1),
  prepared_by: z.string().min(1),
  target: planTargetSchema,
  changes: taskPatchSchema,
  hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

export const applyTaskUpdateInputSchema = z.strictObject({ plan: taskUpdatePlanSchema });

export const prepareCommentInputSchema = z.strictObject({
  task_gid: gidSchema,
  text: z.string().min(1).max(8_000),
});

export const commentPlanSchema = z.strictObject({
  version: z.literal(1),
  operation: z.literal("task.comment"),
  task_gid: gidSchema,
  expected_modified_at: z.string().min(1),
  prepared_by: z.string().min(1),
  target: planTargetSchema,
  text: z.string().min(1).max(8_000),
  hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

export const applyCommentInputSchema = z.strictObject({ plan: commentPlanSchema });
