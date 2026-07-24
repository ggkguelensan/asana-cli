import { z } from "zod";
import {
  projectAliasSchema,
  qualifiedTaskAliasSchema,
} from "./repository-context";
import { gidSchema } from "./schemas";

const resultLimitSchema = (maximum: number, fallback: number) =>
  z.number().int().min(1).max(maximum).default(fallback);

export const MAX_AGENT_CONTENT_BYTES = 65_536;
export const DEFAULT_AGENT_CONTENT_BYTES = 16_384;
export const MAX_BATCH_TASKS = 10;

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

export const operationStatusInputSchema = z.strictObject({
  operation_id: z.uuid(),
});

export const gitCurrentInputSchema = z.strictObject({
  git_current: z.literal(true),
});
export const worktreeTaskInputSchema = z.strictObject({
  worktree_task: z.literal(true),
});
export const repositoryAsanaInputSchema = z.strictObject({
  repository_asana: z.literal(true),
});
export const repositoryContextInputSchema = z.strictObject({
  repository_context: z.literal(true),
});

export const gitCurrentCandidatesInputSchema = z.strictObject({
  workspace_gid: gidSchema,
  all_assignees: z.boolean().default(false),
  completed: z.boolean().optional(),
  field_gid: gidSchema.optional(),
});

export const myTasksInputSchema = z.strictObject({
  workspace_gid: gidSchema.optional(),
  completed: z.enum(["false", "true", "all"]).default("false"),
  limit: resultLimitSchema(100, 50),
  paginate: z.boolean().default(false),
  max_results: resultLimitSchema(500, 100),
});

const contextCollectionFields = {
  limit: resultLimitSchema(100, 50),
  paginate: z.boolean().default(false),
  max_results: resultLimitSchema(200, 100),
};

export const listProjectsInputSchema = z.strictObject({
  workspace_gid: gidSchema,
  archived: z.boolean().default(false),
  ...contextCollectionFields,
});

export const listSectionsInputSchema = z.strictObject({
  project_gid: gidSchema,
  ...contextCollectionFields,
});

export const listProjectMembershipsInputSchema = z.strictObject({
  project_gid: gidSchema,
  member_gid: gidSchema.optional(),
  ...contextCollectionFields,
});

export const listCustomFieldsInputSchema = z.strictObject({
  workspace_gid: gidSchema,
  ...contextCollectionFields,
});

export const getCustomFieldInputSchema = z.strictObject({
  field_gid: gidSchema,
  include_values: z.boolean().default(false),
  max_content_bytes: contentBudgetValueSchema.optional(),
}).superRefine((input, context) => {
  if (!input.include_values && input.max_content_bytes !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["max_content_bytes"],
      message: "max_content_bytes requires include_values",
    });
  }
}).meta({
  if: {
    properties: { include_values: { const: false } },
  },
  then: {
    not: { required: ["max_content_bytes"] },
  },
});

const userIdentifierSchema = z.union([
  gidSchema,
  z.literal("me"),
  z.string().max(320).email(),
]);

export const resolveUserInputSchema = z.strictObject({
  workspace_gid: gidSchema,
  user: userIdentifierSchema,
});

export const taskContextIncludeSchema = z.enum([
  "notes",
  "field-values",
]);

export type TaskContextInclude = z.output<typeof taskContextIncludeSchema>;
export const TASK_CONTEXT_INCLUDES = taskContextIncludeSchema.options;

export const taskContextInputSchema = z.strictObject({
  task_gid: gidSchema,
  include: z.array(taskContextIncludeSchema)
    .max(TASK_CONTEXT_INCLUDES.length)
    .default([]),
  max_related_results: resultLimitSchema(100, 20),
  max_content_bytes: contentBudgetSchema,
});

export const batchTasksInputSchema = z.strictObject({
  task_gids: z.array(gidSchema)
    .min(1)
    .max(MAX_BATCH_TASKS)
    .refine(
      (taskGids) => new Set(taskGids).size === taskGids.length,
      "task_gids must be unique",
    )
    .meta({ uniqueItems: true }),
  include: z.array(taskIncludeSelectorSchema)
    .max(TASK_INCLUDE_SELECTORS.length)
    .refine(
      (includes) => new Set(includes).size === includes.length,
      "include selectors must be unique",
    )
    .default([])
    .meta({ uniqueItems: true }),
  max_content_bytes: contentBudgetSchema,
});

export const canonicalTaskReferenceSchema = z.union([
  z.string().regex(/^gid:\d{1,64}$/),
  z.string().regex(
    /^url:https:\/\/app\.asana\.com\/0\/(?:0|\d{1,64})\/\d{1,64}(?:\/f)?$/,
  ),
  z.string().regex(
    /^url:https:\/\/app\.asana\.com\/1\/\d{1,64}\/(?:project\/\d{1,64}\/)?task\/\d{1,64}$/,
  ),
  z.string().regex(
    /^custom:\d{1,64}\/[A-Za-z0-9]{1,20}-[1-9][0-9]{0,63}$/,
  ),
  qualifiedTaskAliasSchema,
]);

export const resolveTaskInputSchema = z.strictObject({
  reference: canonicalTaskReferenceSchema,
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

export const customFieldValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string()),
]);

const customFieldsPatchSchema = z.record(gidSchema, customFieldValueSchema)
  .refine((fields) => Object.keys(fields).length <= 50, "Too many custom field updates")
  .meta({ maxProperties: 50 });

const taskCreateFieldsShape = {
  name: z.string().min(1).max(500),
  notes: z.string().max(8_000).optional(),
  due_on: z.iso.date().optional(),
  due_at: z.iso.datetime({ offset: true }).optional(),
  start_on: z.iso.date().optional(),
  custom_fields: customFieldsPatchSchema.optional(),
};

function hasConflictingDueDates(
  fields: Readonly<{ due_on?: string; due_at?: string }>,
): boolean {
  return fields.due_on !== undefined && fields.due_at !== undefined;
}

function hasStartWithoutDueDate(
  fields: Readonly<{ due_on?: string; due_at?: string; start_on?: string }>,
): boolean {
  return fields.start_on !== undefined &&
    fields.due_on === undefined &&
    fields.due_at === undefined;
}

export const taskCreateInputFieldsSchema = z.strictObject(taskCreateFieldsShape)
  .refine((fields) => !hasConflictingDueDates(fields), {
    message: "task fields cannot set due_on and due_at together",
  })
  .refine((fields) => !hasStartWithoutDueDate(fields), {
    message: "task start_on requires due_on or due_at",
  })
  .meta({
    not: {
      required: ["due_on", "due_at"],
    },
    if: {
      required: ["start_on"],
    },
    then: {
      anyOf: [
        { required: ["due_on"] },
        { required: ["due_at"] },
      ],
    },
  });

export const expandedTaskCreateFieldsSchema = z.strictObject({
  ...taskCreateFieldsShape,
  assignee_gid: gidSchema,
}).refine((fields) => !hasConflictingDueDates(fields), {
  message: "task fields cannot set due_on and due_at together",
}).refine((fields) => !hasStartWithoutDueDate(fields), {
  message: "task start_on requires due_on or due_at",
}).meta({
  not: {
    required: ["due_on", "due_at"],
  },
  if: {
    required: ["start_on"],
  },
  then: {
    anyOf: [
      { required: ["due_on"] },
      { required: ["due_at"] },
    ],
  },
});

export const taskCreateOverridesSchema = z.strictObject({
  name: z.string().min(1).max(500).optional(),
  notes: z.string().max(8_000).optional(),
  due_on: z.iso.date().optional(),
  due_at: z.iso.datetime({ offset: true }).optional(),
  start_on: z.iso.date().optional(),
  custom_fields: customFieldsPatchSchema.optional(),
}).refine((fields) => !hasConflictingDueDates(fields), {
  message: "task fields cannot set due_on and due_at together",
}).meta({
  not: {
    required: ["due_on", "due_at"],
  },
});

export const taskCreateTemplateMetadataSchema = z.strictObject({
  schema: z.literal("asana-cli.task-create-templates.v1"),
  alias: projectAliasSchema,
  revision: z.number().int().min(1).max(2_147_483_647),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  context_revision: z.number().int().min(1).max(2_147_483_647),
  context_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

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

export const prepareCommentInputSchema = z.strictObject({
  task_gid: gidSchema,
  text: z.string().min(1).max(8_000),
});

export const prepareTaskCreateInputSchema = z.strictObject({
  workspace_gid: gidSchema,
  project_gid: gidSchema,
  task: taskCreateInputFieldsSchema,
});

export const prepareSubtaskCreateInputSchema = z.strictObject({
  parent_task_gid: gidSchema,
  project_gid: gidSchema,
  task: taskCreateInputFieldsSchema,
});

export const prepareTaskProjectAddInputSchema = z.strictObject({
  task_gid: gidSchema,
  project_gid: gidSchema,
  section_gid: gidSchema.optional(),
});

export const prepareTaskProjectRemoveInputSchema = z.strictObject({
  task_gid: gidSchema,
  project_gid: gidSchema,
});

export const prepareTaskSectionMoveInputSchema = z.strictObject({
  task_gid: gidSchema,
  project_gid: gidSchema,
  section_gid: gidSchema,
});

export const prepareTaskDependencyAddInputSchema = z.strictObject({
  task_gid: gidSchema,
  dependency_task_gid: gidSchema,
}).refine((input) => input.task_gid !== input.dependency_task_gid, {
  message: "a task cannot depend on itself",
  path: ["dependency_task_gid"],
});

export const prepareTaskDependencyRemoveInputSchema = z.strictObject({
  task_gid: gidSchema,
  dependency_task_gid: gidSchema,
}).refine((input) => input.task_gid !== input.dependency_task_gid, {
  message: "a task cannot be its own dependency",
  path: ["dependency_task_gid"],
});

export const prepareTaskFromTemplateInputSchema = z.strictObject({
  template: projectAliasSchema,
  template_revision: z.number().int().min(1).max(2_147_483_647),
  task: taskCreateOverridesSchema.default({}),
});

export const applyOperationInputSchema = z.strictObject({
  operation_id: z.uuid(),
});
