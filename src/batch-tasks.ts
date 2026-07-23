import { z } from "zod";
import {
  MAX_AGENT_CONTENT_BYTES,
  MAX_BATCH_TASKS,
  type TaskIncludeSelector,
} from "./agent-action-schemas";
import {
  ContentBudget,
  contentBudgetMetadataSchema,
} from "./content-budget";
import { CliError } from "./errors";
import {
  gidSchema,
  taskSchema,
} from "./schemas";
import {
  asCollection,
  collectPages,
  invokeApiMethod,
  type AsanaClient,
} from "./sdk";

const timestampSchema = z.string().max(128);
const boundedContentSchema = z.string().max(MAX_AGENT_CONTENT_BYTES);
const batchTaskResourceSchema = z.strictObject({
  gid: gidSchema,
  name: boundedContentSchema.optional(),
});
const batchTaskMembershipSchema = z.strictObject({
  project: batchTaskResourceSchema.optional(),
  section: batchTaskResourceSchema.optional(),
});
const displayValueSchema = z.union([
  boundedContentSchema,
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.union([
    boundedContentSchema,
    z.number(),
    z.boolean(),
    z.null(),
  ])).max(50),
]);
const batchTaskCustomFieldSchema = z.strictObject({
  gid: gidSchema.optional(),
  name: boundedContentSchema.optional(),
  display_value: displayValueSchema.optional(),
  text_value: displayValueSchema.optional(),
});

export const batchTaskProjectionSchema = z.strictObject({
  gid: gidSchema,
  name: boundedContentSchema.optional(),
  completed: z.boolean().optional(),
  completed_at: timestampSchema.nullable().optional(),
  assignee: batchTaskResourceSchema.nullable().optional(),
  due_on: timestampSchema.nullable().optional(),
  due_at: timestampSchema.nullable().optional(),
  start_on: timestampSchema.nullable().optional(),
  projects: z.array(batchTaskResourceSchema).max(100).optional(),
  memberships: z.array(batchTaskMembershipSchema).max(100).optional(),
  modified_at: timestampSchema.optional(),
  notes: boundedContentSchema.optional(),
  html_notes: boundedContentSchema.optional(),
  custom_fields: z.array(batchTaskCustomFieldSchema).max(50).optional(),
  tags: z.array(batchTaskResourceSchema).max(100).optional(),
  parent: batchTaskResourceSchema.nullable().optional(),
  created_at: timestampSchema.optional(),
});

export const batchTaskItemErrorCodeSchema = z.enum([
  "auth-failed",
  "not-found",
  "premium-required",
  "conflict",
  "rate-limited",
  "asana-api",
  "invalid-response",
]);

const batchTaskTruncatedFieldSchema = z.enum([
  "projects",
  "memberships",
  "custom_fields",
  "custom_field_values",
  "tags",
]);

const batchTaskSuccessSchema = z.strictObject({
  task_gid: gidSchema,
  outcome: z.literal("success"),
  task: batchTaskProjectionSchema,
  projection: z.strictObject({
    truncated: z.boolean(),
    truncated_fields: z.array(batchTaskTruncatedFieldSchema)
      .max(batchTaskTruncatedFieldSchema.options.length),
  }),
});
const batchTaskErrorSchema = z.strictObject({
  task_gid: gidSchema,
  outcome: z.literal("error"),
  error: z.strictObject({
    code: batchTaskItemErrorCodeSchema,
    status_code: z.number().int().min(100).max(599).optional(),
  }),
});

export const batchTasksDataSchema = z.strictObject({
  schema: z.literal("asana-cli.task-batch.v1"),
  results: z.array(z.discriminatedUnion("outcome", [
    batchTaskSuccessSchema,
    batchTaskErrorSchema,
  ])).min(1).max(MAX_BATCH_TASKS),
  content_profile: z.enum(["metadata", "selected-untrusted"]),
  content_budget: contentBudgetMetadataSchema,
  meta: z.strictObject({
    requested: z.number().int().min(1).max(MAX_BATCH_TASKS),
    succeeded: z.number().int().min(0).max(MAX_BATCH_TASKS),
    failed: z.number().int().min(0).max(MAX_BATCH_TASKS),
    partial: z.boolean(),
    request_budget: z.strictObject({
      max_actions: z.literal(MAX_BATCH_TASKS),
      used_actions: z.number().int().min(1).max(MAX_BATCH_TASKS),
      transport_requests: z.literal(1),
    }),
    result_budget: z.strictObject({
      max_results: z.literal(MAX_BATCH_TASKS),
      emitted_results: z.number().int().min(1).max(MAX_BATCH_TASKS),
    }),
  }),
});

type BatchTasksInput = Readonly<{
  task_gids: readonly string[];
  include: readonly TaskIncludeSelector[];
  max_content_bytes: number;
}>;

const baseTaskFields = [
  "gid",
  "name",
  "completed",
  "completed_at",
  "assignee",
  "assignee.gid",
  "assignee.name",
  "due_on",
  "due_at",
  "start_on",
  "projects",
  "projects.gid",
  "projects.name",
  "memberships",
  "memberships.project.gid",
  "memberships.project.name",
  "memberships.section.gid",
  "memberships.section.name",
  "modified_at",
] as const;

const includeTaskFields = {
  notes: ["notes"],
  html_notes: ["html_notes"],
  custom_fields: [
    "custom_fields",
    "custom_fields.gid",
    "custom_fields.name",
    "custom_fields.display_value",
    "custom_fields.text_value",
  ],
  tags: ["tags", "tags.gid", "tags.name"],
  parent: ["parent", "parent.gid", "parent.name"],
  created_at: ["created_at"],
} as const satisfies Record<TaskIncludeSelector, readonly string[]>;

const batchRequestActionSchema = z.strictObject({
  method: z.literal("GET"),
  relative_path: z.string().regex(/^\/tasks\/\d{1,64}\?opt_fields=/),
});
const batchRequestBodySchema = z.strictObject({
  data: z.strictObject({
    actions: z.array(batchRequestActionSchema).min(1).max(MAX_BATCH_TASKS),
  }),
});

const batchExternalResultSchema = z.looseObject({
  status_code: z.number().int().min(100).max(599),
  body: z.unknown(),
});
const batchSuccessBodySchema = z.looseObject({
  data: taskSchema,
});

function taskFields(includes: readonly TaskIncludeSelector[]): string {
  const fields = new Set<string>(baseTaskFields);
  for (const include of includes) {
    for (const field of includeTaskFields[include]) fields.add(field);
  }
  return [...fields].join(",");
}

function projectResource(
  value: unknown,
  budget: ContentBudget,
  path: string,
): z.output<typeof batchTaskResourceSchema> | undefined {
  const parsed = z.looseObject({
    gid: gidSchema,
    name: z.string().optional(),
  }).safeParse(value);
  if (!parsed.success) return undefined;
  return batchTaskResourceSchema.parse({
    gid: parsed.data.gid,
    ...(parsed.data.name === undefined
      ? {}
      : { name: budget.take(parsed.data.name, `${path}.name`) }),
  });
}

function projectResources(
  value: unknown,
  budget: ContentBudget,
  path: string,
  maximum: number,
): z.output<typeof batchTaskResourceSchema>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, maximum).flatMap((entry, index) => {
    const projected = projectResource(entry, budget, `${path}[${index}]`);
    return projected === undefined ? [] : [projected];
  });
}

function projectDisplayValue(
  value: unknown,
  budget: ContentBudget,
  path: string,
  truncatedFields: Set<z.output<typeof batchTaskTruncatedFieldSchema>>,
): z.output<typeof displayValueSchema> | undefined {
  if (typeof value === "string") return budget.take(value, path);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (!Array.isArray(value)) return undefined;
  if (value.length > 50) truncatedFields.add("custom_field_values");
  return value.slice(0, 50).flatMap((entry, index) => {
    if (typeof entry === "string") return [budget.take(entry, `${path}[${index}]`)];
    if (typeof entry === "number" || typeof entry === "boolean" || entry === null) {
      return [entry];
    }
    return [];
  });
}

function projectBatchTask(
  value: z.output<typeof taskSchema>,
  includes: readonly TaskIncludeSelector[],
  budget: ContentBudget,
  path: string,
): {
  task: z.output<typeof batchTaskProjectionSchema>;
  truncatedFields: z.output<typeof batchTaskTruncatedFieldSchema>[];
} {
  const selected = new Set(includes);
  const truncatedFields = new Set<z.output<typeof batchTaskTruncatedFieldSchema>>();
  if ((value.projects?.length ?? 0) > 100) truncatedFields.add("projects");
  if ((value.memberships?.length ?? 0) > 100) truncatedFields.add("memberships");
  if (selected.has("custom_fields") && (value.custom_fields?.length ?? 0) > 50) {
    truncatedFields.add("custom_fields");
  }
  if (selected.has("tags") && (value.tags?.length ?? 0) > 100) {
    truncatedFields.add("tags");
  }
  const name = value.name === undefined
    ? undefined
    : budget.take(value.name, `${path}.name`);
  const assignee = value.assignee === null
    ? null
    : projectResource(value.assignee, budget, `${path}.assignee`);
  const projects = projectResources(value.projects, budget, `${path}.projects`, 100);
  const memberships = value.memberships?.slice(0, 100).map((membership, index) => {
    const project = projectResource(
      membership.project,
      budget,
      `${path}.memberships[${index}].project`,
    );
    const section = projectResource(
      membership.section,
      budget,
      `${path}.memberships[${index}].section`,
    );
    return {
      ...(project === undefined ? {} : { project }),
      ...(section === undefined ? {} : { section }),
    };
  });
  const customFields = selected.has("custom_fields")
    ? value.custom_fields?.slice(0, 50).map((field, index) => {
      const fieldPath = `${path}.custom_fields[${index}]`;
      const gid = gidSchema.safeParse(field.gid);
      return batchTaskCustomFieldSchema.parse({
        ...(gid.success ? { gid: gid.data } : {}),
        ...(field.name === undefined
          ? {}
          : { name: budget.take(field.name, `${fieldPath}.name`) }),
        ...(field.display_value === undefined
          ? {}
          : {
            display_value: projectDisplayValue(
              field.display_value,
              budget,
              `${fieldPath}.display_value`,
              truncatedFields,
            ),
          }),
        ...(field.text_value === undefined
          ? {}
          : {
            text_value: projectDisplayValue(
              field.text_value,
              budget,
              `${fieldPath}.text_value`,
              truncatedFields,
            ),
          }),
      });
    })
    : undefined;

  return {
    task: batchTaskProjectionSchema.parse({
      gid: gidSchema.parse(value.gid),
      ...(name === undefined ? {} : { name }),
      ...(value.completed === undefined ? {} : { completed: value.completed }),
      ...(value.completed_at === undefined ? {} : { completed_at: value.completed_at }),
      ...(assignee === undefined ? {} : { assignee }),
      ...(value.due_on === undefined ? {} : { due_on: value.due_on }),
      ...(value.due_at === undefined ? {} : { due_at: value.due_at }),
      ...(value.start_on === undefined ? {} : { start_on: value.start_on }),
      ...(projects === undefined ? {} : { projects }),
      ...(memberships === undefined ? {} : { memberships }),
      ...(value.modified_at === undefined ? {} : { modified_at: value.modified_at }),
      ...(!selected.has("notes") || value.notes === undefined
        ? {}
        : { notes: budget.take(value.notes, `${path}.notes`) }),
      ...(!selected.has("html_notes") || value.html_notes === undefined
        ? {}
        : { html_notes: budget.take(value.html_notes, `${path}.html_notes`) }),
      ...(customFields === undefined ? {} : { custom_fields: customFields }),
      ...(!selected.has("tags")
        ? {}
        : {
          tags: projectResources(value.tags, budget, `${path}.tags`, 100) ?? [],
        }),
      ...(!selected.has("parent")
        ? {}
        : {
          parent: value.parent === null
            ? null
            : projectResource(value.parent, budget, `${path}.parent`),
        }),
      ...(!selected.has("created_at") || value.created_at === undefined
        ? {}
        : { created_at: value.created_at }),
    }),
    truncatedFields: batchTaskTruncatedFieldSchema.options.filter(
      (field) => truncatedFields.has(field),
    ),
  };
}

function itemErrorCode(
  statusCode: number,
): z.output<typeof batchTaskItemErrorCodeSchema> {
  if (statusCode === 401 || statusCode === 403) return "auth-failed";
  if (statusCode === 404) return "not-found";
  if (statusCode === 402) return "premium-required";
  if (statusCode === 409 || statusCode === 412) return "conflict";
  if (statusCode === 424 || statusCode === 429) return "rate-limited";
  return "asana-api";
}

function invalidItem(taskGid: string): z.output<typeof batchTaskErrorSchema> {
  return {
    task_gid: taskGid,
    outcome: "error",
    error: { code: "invalid-response" },
  };
}

export async function batchReadTasks(
  client: AsanaClient,
  input: BatchTasksInput,
): Promise<z.output<typeof batchTasksDataSchema>> {
  const fields = taskFields(input.include);
  const request = batchRequestBodySchema.parse({
    data: {
      actions: input.task_gids.map((taskGid) => ({
        method: "GET",
        relative_path: `/tasks/${taskGid}?opt_fields=${encodeURIComponent(fields)}`,
      })),
    },
  });
  const response = await invokeApiMethod(
    client,
    "BatchAPIApi",
    "createBatchRequest",
    [request, { opt_fields: "body,status_code" }],
  );
  const collected = await collectPages(
    asCollection(response, "BatchAPIApi.createBatchRequest"),
    false,
    MAX_BATCH_TASKS,
    z.unknown(),
    "BatchAPIApi.createBatchRequest",
    true,
  );
  if (
    collected.data.length !== input.task_gids.length ||
    collected.truncated ||
    (collected.next_page !== null && collected.next_page !== undefined)
  ) {
    throw new CliError(
      "internal",
      "Asana batch response did not match the exact requested task set",
    );
  }

  const budget = new ContentBudget(input.max_content_bytes);
  const results = collected.data.map((rawResult, index) => {
    const taskGid = input.task_gids[index]!;
    const result = batchExternalResultSchema.safeParse(rawResult);
    if (!result.success) return invalidItem(taskGid);
    if (result.data.status_code < 200 || result.data.status_code >= 300) {
      return batchTaskErrorSchema.parse({
        task_gid: taskGid,
        outcome: "error",
        error: {
          code: itemErrorCode(result.data.status_code),
          status_code: result.data.status_code,
        },
      });
    }
    const body = batchSuccessBodySchema.safeParse(result.data.body);
    if (!body.success || body.data.data.gid !== taskGid) return invalidItem(taskGid);
    try {
      const projected = projectBatchTask(
        body.data.data,
        input.include,
        budget,
        `results[${index}].task`,
      );
      return batchTaskSuccessSchema.parse({
        task_gid: taskGid,
        outcome: "success",
        task: projected.task,
        projection: {
          truncated: projected.truncatedFields.length > 0,
          truncated_fields: projected.truncatedFields,
        },
      });
    } catch {
      return invalidItem(taskGid);
    }
  });
  const succeeded = results.filter((result) => result.outcome === "success").length;
  const failed = results.length - succeeded;

  return batchTasksDataSchema.parse({
    schema: "asana-cli.task-batch.v1",
    results,
    content_profile: input.include.length === 0 ? "metadata" : "selected-untrusted",
    content_budget: budget.metadata(),
    meta: {
      requested: input.task_gids.length,
      succeeded,
      failed,
      partial: failed > 0 && succeeded > 0,
      request_budget: {
        max_actions: MAX_BATCH_TASKS,
        used_actions: input.task_gids.length,
        transport_requests: 1,
      },
      result_budget: {
        max_results: MAX_BATCH_TASKS,
        emitted_results: results.length,
      },
    },
  });
}
