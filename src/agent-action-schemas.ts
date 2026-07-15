import { z } from "zod";
import { gidSchema } from "./schemas";

const resultLimitSchema = (maximum: number, fallback: number) =>
  z.number().int().min(1).max(maximum).default(fallback);

export const statusInputSchema = z.strictObject({});

export const myTasksInputSchema = z.strictObject({
  workspace_gid: gidSchema.optional(),
  completed: z.enum(["false", "true", "all"]).default("false"),
  limit: resultLimitSchema(100, 50),
  paginate: z.boolean().default(false),
  max_results: resultLimitSchema(500, 100),
});

export const getTaskInputSchema = z.strictObject({
  task_gid: gidSchema,
  include_content: z.boolean().default(false),
});

export const listCommentsInputSchema = z.strictObject({
  task_gid: gidSchema,
  limit: resultLimitSchema(100, 50),
  paginate: z.boolean().default(false),
  max_results: resultLimitSchema(500, 100),
});

export const searchInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(500),
  workspace_gid: gidSchema.optional(),
  all_assignees: z.boolean().default(false),
  completed: z.boolean().optional(),
  max_results: resultLimitSchema(100, 100),
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

const taskPatchSchema = z.strictObject({
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
    not: { required: ["due_on", "due_at"] },
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
