import { z } from "zod";
import {
  type TaskContextInclude,
} from "./agent-action-schemas";
import {
  ContentBudget,
  contentBudgetMetadataSchema,
} from "./content-budget";
import { CliError, errorStatus } from "./errors";
import { gidSchema, parseExternalData } from "./schemas";
import {
  asCollection,
  collectPages,
  invokeApiMethod,
  type AsanaClient,
} from "./sdk";

const boundedNameSchema = z.string().max(10_000);
const boundedTextSchema = z.string().max(1_000_000);
const timestampSchema = z.string().max(128);
const subtypeSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/);

const externalResourceSchema = z.looseObject({
  gid: gidSchema,
  name: boundedNameSchema.optional(),
});

const externalMembershipSchema = z.looseObject({
  project: externalResourceSchema,
  section: externalResourceSchema.optional(),
});

const externalTaskCustomFieldSchema = z.looseObject({
  gid: gidSchema,
  name: boundedNameSchema.optional(),
  resource_subtype: subtypeSchema.optional(),
  representation_type: subtypeSchema.optional(),
  display_value: z.string().max(100_000).nullable().optional(),
});

const externalContextTaskSchema = z.looseObject({
  gid: gidSchema,
  name: boundedNameSchema.optional(),
  completed: z.boolean().optional(),
  completed_at: timestampSchema.nullable().optional(),
  created_at: timestampSchema.optional(),
  modified_at: timestampSchema.optional(),
  due_on: timestampSchema.nullable().optional(),
  due_at: timestampSchema.nullable().optional(),
  start_on: timestampSchema.nullable().optional(),
  num_subtasks: z.number().int().nonnegative().max(1_000_000).optional(),
  workspace: externalResourceSchema,
  assignee: externalResourceSchema.nullable().optional(),
  parent: externalResourceSchema.nullable().optional(),
  memberships: z.array(externalMembershipSchema).max(100).default([]),
  custom_fields: z.array(externalTaskCustomFieldSchema).max(100).default([]),
  notes: boundedTextSchema.optional(),
});

const externalRelatedTaskSchema = z.looseObject({
  gid: gidSchema,
  name: boundedNameSchema.optional(),
  completed: z.boolean().optional(),
  due_on: timestampSchema.nullable().optional(),
  due_at: timestampSchema.nullable().optional(),
  parent: externalResourceSchema.optional(),
});

const externalAttachmentSchema = z.looseObject({
  gid: gidSchema,
  name: boundedNameSchema.optional(),
  resource_subtype: subtypeSchema.optional(),
  created_at: timestampSchema.optional(),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  parent: externalResourceSchema.optional(),
});

const contextResourceSchema = z.strictObject({
  gid: gidSchema,
  name: boundedNameSchema.optional(),
});

const contextMembershipSchema = z.strictObject({
  project: contextResourceSchema,
  section: contextResourceSchema.optional(),
});

const contextTaskCustomFieldSchema = z.strictObject({
  gid: gidSchema,
  name: boundedNameSchema.optional(),
  resource_subtype: subtypeSchema.optional(),
  representation_type: subtypeSchema.optional(),
  display_value: z.string().max(100_000).nullable().optional(),
});

const relatedTaskSchema = z.strictObject({
  gid: gidSchema,
  name: boundedNameSchema.optional(),
  completed: z.boolean().optional(),
  due_on: timestampSchema.nullable().optional(),
  due_at: timestampSchema.nullable().optional(),
});

const attachmentMetadataSchema = z.strictObject({
  gid: gidSchema,
  name: boundedNameSchema.optional(),
  resource_subtype: subtypeSchema.optional(),
  created_at: timestampSchema.optional(),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});

const sourceMetaSchema = z.strictObject({
  count: z.number().int().nonnegative().max(100),
  max_results: z.number().int().min(1).max(100),
  truncated: z.boolean(),
  has_more: z.boolean(),
  status: z.enum(["ok", "premium-required"]),
});

export const taskContextDataSchema = z.strictObject({
  task: z.strictObject({
    gid: gidSchema,
    name: boundedNameSchema.optional(),
    completed: z.boolean().optional(),
    completed_at: timestampSchema.nullable().optional(),
    created_at: timestampSchema.optional(),
    modified_at: timestampSchema.optional(),
    due_on: timestampSchema.nullable().optional(),
    due_at: timestampSchema.nullable().optional(),
    start_on: timestampSchema.nullable().optional(),
    num_subtasks: z.number().int().nonnegative().max(1_000_000).optional(),
    workspace: contextResourceSchema,
    assignee: contextResourceSchema.nullable().optional(),
    parent: contextResourceSchema.nullable().optional(),
    memberships: z.array(contextMembershipSchema).max(100),
    custom_fields: z.array(contextTaskCustomFieldSchema).max(100),
    notes: boundedTextSchema.optional(),
  }),
  subtasks: z.array(relatedTaskSchema).max(100),
  dependencies: z.array(relatedTaskSchema).max(100),
  dependents: z.array(relatedTaskSchema).max(100),
  attachments: z.array(attachmentMetadataSchema).max(100),
  content_profile: z.enum(["metadata", "selected-untrusted"]),
  content_budget: contentBudgetMetadataSchema,
  meta: z.strictObject({
    task_gid: gidSchema,
    max_related_results: z.number().int().min(1).max(100),
    related_count: z.number().int().nonnegative().max(400),
    truncated: z.boolean(),
    partial: z.boolean(),
    sources: z.strictObject({
      subtasks: sourceMetaSchema,
      dependencies: sourceMetaSchema,
      dependents: sourceMetaSchema,
      attachments: sourceMetaSchema,
    }),
  }),
});

type ContextInput = Readonly<{
  task_gid: string;
  include: readonly TaskContextInclude[];
  max_related_results: number;
  max_content_bytes: number;
}>;

function compactObject(entries: Array<[string, unknown]>): Record<string, unknown> {
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
}

function resourceProjection(
  resource: z.output<typeof externalResourceSchema>,
  budget: ContentBudget,
  path: string,
): z.output<typeof contextResourceSchema> {
  return contextResourceSchema.parse(compactObject([
    ["gid", resource.gid],
    [
      "name",
      resource.name === undefined
        ? undefined
        : budget.take(resource.name, `${path}.name`),
    ],
  ]));
}

function nullableResourceProjection(
  resource: z.output<typeof externalResourceSchema> | null | undefined,
  budget: ContentBudget,
  path: string,
): z.output<typeof contextResourceSchema> | null | undefined {
  if (resource === null || resource === undefined) return resource;
  return resourceProjection(resource, budget, path);
}

type BoundedCollection<Item> = Readonly<{
  data: Item[];
  meta: z.output<typeof sourceMetaSchema>;
}>;

async function readCollection<Item>(
  client: AsanaClient,
  apiClass: string,
  method: string,
  args: unknown[],
  maximum: number,
  schema: z.ZodType<Item>,
): Promise<BoundedCollection<Item>> {
  const context = `${apiClass}.${method}`;
  let value: unknown;
  try {
    value = await invokeApiMethod(client, apiClass, method, args);
  } catch (error: unknown) {
    if (errorStatus(error) !== 402) throw error;
    return {
      data: [],
      meta: sourceMetaSchema.parse({
        count: 0,
        max_results: maximum,
        truncated: true,
        has_more: false,
        status: "premium-required",
      }),
    };
  }
  const collected = await collectPages(
    asCollection(value, context),
    false,
    maximum,
    schema,
    context,
    true,
  );
  const hasMore = collected.next_page !== null &&
    collected.next_page !== undefined;
  return {
    data: collected.data,
    meta: sourceMetaSchema.parse({
      count: collected.data.length,
      max_results: maximum,
      truncated: collected.truncated ?? false,
      has_more: hasMore,
      status: "ok",
    }),
  };
}

function relatedTaskProjection(
  task: z.output<typeof externalRelatedTaskSchema>,
  budget: ContentBudget,
  path: string,
): z.output<typeof relatedTaskSchema> {
  return relatedTaskSchema.parse(compactObject([
    ["gid", task.gid],
    [
      "name",
      task.name === undefined
        ? undefined
        : budget.take(task.name, `${path}.name`),
    ],
    ["completed", task.completed],
    ["due_on", task.due_on],
    ["due_at", task.due_at],
  ]));
}

function assertSubtaskParent(
  task: z.output<typeof externalRelatedTaskSchema>,
  taskGid: string,
): void {
  if (task.parent !== undefined && task.parent.gid !== taskGid) {
    throw new CliError("internal", "Invalid scoped response from TasksApi.getSubtasksForTask");
  }
}

function assertAttachmentParent(
  attachment: z.output<typeof externalAttachmentSchema>,
  taskGid: string,
): void {
  if (attachment.parent !== undefined && attachment.parent.gid !== taskGid) {
    throw new CliError(
      "internal",
      "Invalid scoped response from AttachmentsApi.getAttachmentsForObject",
    );
  }
}

export async function getTaskContext(
  client: AsanaClient,
  input: ContextInput,
): Promise<z.output<typeof taskContextDataSchema>> {
  const includes = new Set(input.include);
  const taskFields = [
    "gid",
    "name",
    "completed",
    "completed_at",
    "created_at",
    "modified_at",
    "due_on",
    "due_at",
    "start_on",
    "num_subtasks",
    "workspace",
    "workspace.gid",
    "workspace.name",
    "assignee",
    "assignee.gid",
    "assignee.name",
    "parent",
    "parent.gid",
    "parent.name",
    "memberships",
    "memberships.project",
    "memberships.project.gid",
    "memberships.project.name",
    "memberships.section",
    "memberships.section.gid",
    "memberships.section.name",
    "custom_fields",
    "custom_fields.gid",
    "custom_fields.name",
    "custom_fields.resource_subtype",
    "custom_fields.representation_type",
    ...(includes.has("field-values") ? ["custom_fields.display_value"] : []),
    ...(includes.has("notes") ? ["notes"] : []),
  ];
  const taskValue = await invokeApiMethod(
    client,
    "TasksApi",
    "getTask",
    [input.task_gid, { opt_fields: taskFields.join(",") }],
  );
  const task = parseExternalData(
    taskValue,
    externalContextTaskSchema,
    "TasksApi.getTask",
  );
  if (task.gid !== input.task_gid) {
    throw new CliError("internal", "Invalid task identity from TasksApi.getTask");
  }

  const relatedFields = [
    "gid",
    "name",
    "completed",
    "due_on",
    "due_at",
  ].join(",");
  const [subtasks, dependencies, dependents, attachments] = await Promise.all([
    readCollection(
      client,
      "TasksApi",
      "getSubtasksForTask",
      [
        input.task_gid,
        {
          limit: input.max_related_results,
          opt_fields: `${relatedFields},parent.gid`,
        },
      ],
      input.max_related_results,
      externalRelatedTaskSchema,
    ),
    readCollection(
      client,
      "TasksApi",
      "getDependenciesForTask",
      [
        input.task_gid,
        { limit: input.max_related_results, opt_fields: relatedFields },
      ],
      input.max_related_results,
      externalRelatedTaskSchema,
    ),
    readCollection(
      client,
      "TasksApi",
      "getDependentsForTask",
      [
        input.task_gid,
        { limit: input.max_related_results, opt_fields: relatedFields },
      ],
      input.max_related_results,
      externalRelatedTaskSchema,
    ),
    readCollection(
      client,
      "AttachmentsApi",
      "getAttachmentsForObject",
      [
        input.task_gid,
        {
          limit: input.max_related_results,
          opt_fields: "gid,name,resource_subtype,created_at,size,parent.gid",
        },
      ],
      input.max_related_results,
      externalAttachmentSchema,
    ),
  ]);

  const budget = new ContentBudget(input.max_content_bytes);
  const projectedTask = {
    gid: task.gid,
    ...(task.name === undefined
      ? {}
      : { name: budget.take(task.name, "task.name") }),
    ...(task.completed === undefined ? {} : { completed: task.completed }),
    ...(task.completed_at === undefined ? {} : { completed_at: task.completed_at }),
    ...(task.created_at === undefined ? {} : { created_at: task.created_at }),
    ...(task.modified_at === undefined ? {} : { modified_at: task.modified_at }),
    ...(task.due_on === undefined ? {} : { due_on: task.due_on }),
    ...(task.due_at === undefined ? {} : { due_at: task.due_at }),
    ...(task.start_on === undefined ? {} : { start_on: task.start_on }),
    ...(task.num_subtasks === undefined ? {} : { num_subtasks: task.num_subtasks }),
    workspace: resourceProjection(task.workspace, budget, "task.workspace"),
    ...(task.assignee === undefined
      ? {}
      : { assignee: nullableResourceProjection(task.assignee, budget, "task.assignee") }),
    ...(task.parent === undefined
      ? {}
      : { parent: nullableResourceProjection(task.parent, budget, "task.parent") }),
    memberships: task.memberships.map((membership, index) => ({
      project: resourceProjection(
        membership.project,
        budget,
        `task.memberships[${index}].project`,
      ),
      ...(membership.section === undefined
        ? {}
        : {
          section: resourceProjection(
            membership.section,
            budget,
            `task.memberships[${index}].section`,
          ),
        }),
    })),
    custom_fields: task.custom_fields.map((field, index) =>
      contextTaskCustomFieldSchema.parse(compactObject([
        ["gid", field.gid],
        [
          "name",
          field.name === undefined
            ? undefined
            : budget.take(field.name, `task.custom_fields[${index}].name`),
        ],
        ["resource_subtype", field.resource_subtype],
        ["representation_type", field.representation_type],
        [
          "display_value",
          !includes.has("field-values") || field.display_value === undefined
            ? undefined
            : field.display_value === null
              ? null
              : budget.take(
                field.display_value,
                `task.custom_fields[${index}].display_value`,
              ),
        ],
      ]))
    ),
    ...(!includes.has("notes") || task.notes === undefined
      ? {}
      : { notes: budget.take(task.notes, "task.notes") }),
  };

  const projectedSubtasks = subtasks.data.map((entry, index) => {
    assertSubtaskParent(entry, input.task_gid);
    return relatedTaskProjection(entry, budget, `subtasks[${index}]`);
  });
  const projectedDependencies = dependencies.data.map((entry, index) =>
    relatedTaskProjection(entry, budget, `dependencies[${index}]`)
  );
  const projectedDependents = dependents.data.map((entry, index) =>
    relatedTaskProjection(entry, budget, `dependents[${index}]`)
  );
  const projectedAttachments = attachments.data.map((entry, index) => {
    assertAttachmentParent(entry, input.task_gid);
    return attachmentMetadataSchema.parse(compactObject([
      ["gid", entry.gid],
      [
        "name",
        entry.name === undefined
          ? undefined
          : budget.take(entry.name, `attachments[${index}].name`),
      ],
      ["resource_subtype", entry.resource_subtype],
      ["created_at", entry.created_at],
      ["size", entry.size],
    ]));
  });
  const sources = {
    subtasks: subtasks.meta,
    dependencies: dependencies.meta,
    dependents: dependents.meta,
    attachments: attachments.meta,
  };
  const relatedCount = Object.values(sources)
    .reduce((count, source) => count + source.count, 0);

  return taskContextDataSchema.parse({
    task: projectedTask,
    subtasks: projectedSubtasks,
    dependencies: projectedDependencies,
    dependents: projectedDependents,
    attachments: projectedAttachments,
    content_profile: includes.size > 0 ? "selected-untrusted" : "metadata",
    content_budget: budget.metadata(),
    meta: {
      task_gid: input.task_gid,
      max_related_results: input.max_related_results,
      related_count: relatedCount,
      truncated: Object.values(sources).some((source) => source.truncated),
      partial: Object.values(sources).some((source) => source.status !== "ok"),
      sources,
    },
  });
}
