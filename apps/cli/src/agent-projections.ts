import { z } from "zod";
import { type TaskIncludeSelector } from "./agent-action-schemas";
import { ContentBudget, type ContentBudgetMetadata } from "./content-budget";
import { CliError } from "./errors";
import {
  taskListEnvelopeSchema,
  type AsanaTask,
} from "./schemas";

type Projection = Record<string, unknown>;

function compactObject(entries: Array<[string, unknown]>): Projection {
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
}

function resourceProjection(value: unknown): Projection | null | undefined {
  if (value === null) return null;
  const parsed = z.looseObject({
    gid: z.string(),
    name: z.string().optional(),
  }).safeParse(value);
  if (!parsed.success) return undefined;
  return compactObject([
    ["gid", parsed.data.gid],
    ["name", parsed.data.name],
  ]);
}

function resourcesProjection(value: unknown): Projection[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map(resourceProjection)
    .filter((entry): entry is Projection => entry !== undefined && entry !== null);
}

function budgetedResourceProjection(
  value: unknown,
  budget: ContentBudget,
  path: string,
): Projection | null | undefined {
  if (value === null) return null;
  const parsed = z.looseObject({
    gid: z.string(),
    name: z.string().optional(),
  }).safeParse(value);
  if (!parsed.success) return undefined;
  return compactObject([
    ["gid", parsed.data.gid],
    ["name", parsed.data.name === undefined ? undefined : budget.take(parsed.data.name, `${path}.name`)],
  ]);
}

function budgetedResourcesProjection(
  value: unknown,
  budget: ContentBudget,
  path: string,
): Projection[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((entry, index) => budgetedResourceProjection(entry, budget, `${path}[${index}]`))
    .filter((entry): entry is Projection => entry !== undefined && entry !== null);
}

function membershipProjection(value: unknown): Projection[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry) => {
    const parsed = z.looseObject({}).safeParse(entry);
    if (!parsed.success) return [];
    const project = resourceProjection(parsed.data.project);
    const section = resourceProjection(parsed.data.section);
    return [compactObject([
      ["project", project],
      ["section", section],
    ])];
  });
}

function budgetDisplayValue(
  value: unknown,
  budget: ContentBudget,
  path: string,
): string | number | boolean | null | Array<string | number | boolean | null> | undefined {
  if (typeof value === "string") return budget.take(value, path);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 50).flatMap((entry, index) => {
    if (typeof entry === "string") return [budget.take(entry, `${path}[${index}]`)];
    if (typeof entry === "number" || typeof entry === "boolean" || entry === null) return [entry];
    return [];
  });
}

function customFieldsProjection(
  value: unknown,
  budget: ContentBudget,
  path: string,
): Projection[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 50).flatMap((entry, index) => {
    const parsed = z.looseObject({
      gid: z.string().optional(),
      name: z.string().optional(),
      display_value: z.unknown().optional(),
      text_value: z.unknown().optional(),
    }).safeParse(entry);
    if (!parsed.success) return [];
    return [compactObject([
      ["gid", parsed.data.gid],
      [
        "name",
        parsed.data.name === undefined
          ? undefined
          : budget.take(parsed.data.name, `${path}[${index}].name`),
      ],
      [
        "display_value",
        parsed.data.display_value === undefined
          ? undefined
          : budgetDisplayValue(
              parsed.data.display_value,
              budget,
              `${path}[${index}].display_value`,
            ),
      ],
      [
        "text_value",
        parsed.data.text_value === undefined
          ? undefined
          : budgetDisplayValue(
              parsed.data.text_value,
              budget,
              `${path}[${index}].text_value`,
            ),
      ],
    ])];
  });
}

export function taskMetadataProjection(task: AsanaTask): Projection {
  return compactObject([
    ["gid", task.gid],
    ["name", task.name],
    ["completed", task.completed],
    ["completed_at", task.completed_at],
    ["assignee", resourceProjection(task.assignee)],
    ["due_on", task.due_on],
    ["due_at", task.due_at],
    ["start_on", task.start_on],
    ["projects", resourcesProjection(task.projects)],
    ["memberships", membershipProjection(task.memberships)],
    ["permalink_url", task.permalink_url],
    ["modified_at", task.modified_at],
  ]);
}

export function selectedTaskProjection(
  task: AsanaTask,
  includes: readonly TaskIncludeSelector[],
  budget: ContentBudget,
): Projection {
  const selected = new Set(includes);
  const result = taskMetadataProjection(task);
  if (selected.has("notes") && task.notes !== undefined) {
    result.notes = budget.take(task.notes, "task.notes");
  }
  if (selected.has("html_notes") && task.html_notes !== undefined) {
    result.html_notes = budget.take(task.html_notes, "task.html_notes");
  }
  if (selected.has("custom_fields")) {
    const fields = customFieldsProjection(task.custom_fields, budget, "task.custom_fields");
    if (fields !== undefined) result.custom_fields = fields;
  }
  if (selected.has("tags")) {
    const tags = budgetedResourcesProjection(task.tags, budget, "task.tags");
    if (tags !== undefined) result.tags = tags;
  }
  if (selected.has("parent")) {
    result.parent = budgetedResourceProjection(task.parent, budget, "task.parent");
  }
  if (selected.has("created_at") && task.created_at !== undefined) {
    result.created_at = task.created_at;
  }
  return result;
}

export function projectTaskList(value: unknown, context: string): AsanaTask[] {
  const parsed = taskListEnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    throw new CliError("internal", `Invalid task list from ${context}`);
  }
  return parsed.data.data;
}

export function projectTaskCollection(value: unknown, context: string): {
  data: Projection[];
  meta: Projection;
} {
  const parsed = z.looseObject({
    data: z.array(z.unknown()),
    meta: z.looseObject({
      count: z.number().int().nonnegative(),
      completed: z.enum(["false", "true", "all"]).optional(),
      query: z.string().optional(),
      mine: z.boolean().optional(),
      truncated: z.boolean().optional(),
      workspaces: z.array(z.looseObject({
        workspace: z.string(),
        workspace_name: z.string().optional(),
        count: z.number().int().nonnegative(),
        next_page: z.unknown().optional(),
      })).optional(),
    }),
  }).safeParse(value);
  if (!parsed.success) throw new CliError("internal", `Invalid task collection from ${context}`);
  const tasks = projectTaskList(value, context).map(taskMetadataProjection);
  const workspaces = parsed.data.meta.workspaces?.map((workspace) => compactObject([
    ["workspace", workspace.workspace],
    ["workspace_name", workspace.workspace_name],
    ["count", workspace.count],
    ["has_more", workspace.next_page != null],
  ]));
  return {
    data: tasks,
    meta: compactObject([
      ["count", tasks.length],
      ["completed", parsed.data.meta.completed],
      ["query", parsed.data.meta.query],
      ["mine", parsed.data.meta.mine],
      ["truncated", parsed.data.meta.truncated],
      ["workspaces", workspaces],
    ]),
  };
}

export function projectComments(
  value: unknown,
  maximumContentBytes: number,
): {
  data: Projection[];
  next_page: Projection | null;
  meta: Projection;
  content_budget: ContentBudgetMetadata;
} {
  const parsed = z.looseObject({
    data: z.array(z.looseObject({
      gid: z.string(),
      type: z.string().optional(),
      resource_subtype: z.string().optional(),
      text: z.string().optional(),
      html_text: z.string().optional(),
      created_at: z.string().optional(),
      created_by: z.unknown().optional(),
      is_pinned: z.boolean().optional(),
      is_edited: z.boolean().optional(),
    })),
    next_page: z.unknown(),
    meta: z.looseObject({
      count: z.number().int().nonnegative(),
      task_gid: z.string(),
      all_stories: z.boolean(),
    }),
  }).safeParse(value);
  if (!parsed.success) throw new CliError("internal", "Invalid comment list projection input");

  const budget = new ContentBudget(maximumContentBytes);
  const data = parsed.data.data.map((story, index) => compactObject([
    ["gid", story.gid],
    ["type", story.type],
    ["resource_subtype", story.resource_subtype],
    ["text", story.text === undefined ? undefined : budget.take(story.text, `data[${index}].text`)],
    [
      "html_text",
      story.html_text === undefined
        ? undefined
        : budget.take(story.html_text, `data[${index}].html_text`),
    ],
    ["created_at", story.created_at],
    ["created_by", resourceProjection(story.created_by)],
    ["is_pinned", story.is_pinned],
    ["is_edited", story.is_edited],
  ]));
  return {
    data,
    next_page: parsed.data.next_page == null ? null : { available: true },
    meta: {
      count: parsed.data.meta.count,
      task_gid: parsed.data.meta.task_gid,
      all_stories: parsed.data.meta.all_stories,
    },
    content_budget: budget.metadata(),
  };
}
