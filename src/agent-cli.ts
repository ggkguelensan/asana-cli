import { createHash } from "node:crypto";
import { z } from "zod";
import { stringFlag, type ParsedArgs } from "./args";
import {
  addTaskComment,
  AGENT_USER_FIELDS,
  AGENT_TASK_FIELDS,
  getMe,
  getMyTasks,
  getTask,
  getTaskComments,
  searchTasks,
  STORY_FIELDS,
  TASK_FIELDS,
  updateTask,
} from "./asana-commands";
import { CliError, errorStatus } from "./errors";
import { readAgentJsonInput } from "./io";
import {
  gidSchema,
  parseExternalData,
  storySchema,
  taskListEnvelopeSchema,
  taskSchema,
  userSchema,
  zodIssueSummary,
  type AsanaTask,
  type AsanaUser,
} from "./schemas";
import { type AsanaClient } from "./sdk";
import { containsRegisteredSecret } from "./security";

type JsonObject = Record<string, unknown>;

const agentEnvironmentSchema = z.object({
  ASANA_CLI_AGENT_POLICY: z.enum(["read", "read-write"]).optional().catch(undefined),
});

const resultLimitSchema = (maximum: number, fallback: number) =>
  z.number().int().min(1).max(maximum).default(fallback);

const myTasksInputSchema = z.strictObject({
  workspace_gid: gidSchema.optional(),
  completed: z.enum(["false", "true", "all"]).default("false"),
  limit: resultLimitSchema(100, 50),
  paginate: z.boolean().default(false),
  max_results: resultLimitSchema(500, 100),
});

const getTaskInputSchema = z.strictObject({
  task_gid: gidSchema,
  include_content: z.boolean().default(false),
});

const listCommentsInputSchema = z.strictObject({
  task_gid: gidSchema,
  limit: resultLimitSchema(100, 50),
  paginate: z.boolean().default(false),
  max_results: resultLimitSchema(500, 100),
});

const searchInputSchema = z.strictObject({
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
  .refine((fields) => Object.keys(fields).length <= 50, "Too many custom field updates");

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
  });

const prepareTaskUpdateInputSchema = z.strictObject({
  task_gid: gidSchema,
  patch: taskPatchSchema,
});

const planTargetSchema = z.strictObject({
  gid: gidSchema,
  name: z.string().optional(),
  permalink_url: z.string().optional(),
});

const taskUpdatePlanSchema = z.strictObject({
  version: z.literal(1),
  operation: z.literal("task.update"),
  task_gid: gidSchema,
  expected_modified_at: z.string().min(1),
  prepared_by: z.string().min(1),
  target: planTargetSchema,
  changes: taskPatchSchema,
  hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

const applyTaskUpdateInputSchema = z.strictObject({ plan: taskUpdatePlanSchema });

const prepareCommentInputSchema = z.strictObject({
  task_gid: gidSchema,
  text: z.string().min(1).max(8_000),
});

const commentPlanSchema = z.strictObject({
  version: z.literal(1),
  operation: z.literal("task.comment"),
  task_gid: gidSchema,
  expected_modified_at: z.string().min(1),
  prepared_by: z.string().min(1),
  target: planTargetSchema,
  text: z.string().min(1).max(8_000),
  hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

const applyCommentInputSchema = z.strictObject({ plan: commentPlanSchema });

const ownedTaskSchema = taskSchema.extend({
  modified_at: z.string().min(1),
  assignee: z.looseObject({
    gid: z.string(),
    name: z.string().optional(),
  }),
});

function policy(): "read" | "read-write" {
  return agentEnvironmentSchema.parse(process.env).ASANA_CLI_AGENT_POLICY ?? "read";
}

function stable(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map((entry) => stable(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = z.looseObject({}).parse(value);
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function planHash(plan: unknown): string {
  const parsed = z.looseObject({}).parse(plan);
  const unsigned = Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== "hash"));
  return `sha256:${createHash("sha256").update(stable(unsigned)).digest("hex")}`;
}

function verifyPlanHash(plan: { hash: string }): void {
  if (plan.hash !== planHash(plan)) throw new CliError("Plan hash mismatch", 2);
}

function ensureNoRegisteredSecret(value: unknown, operation: string): void {
  if (containsRegisteredSecret(value)) {
    throw new CliError(
      `${operation} blocked because it contains a credential from the local environment`,
      2,
    );
  }
}

async function ownTask(
  client: AsanaClient,
  taskGid: string,
): Promise<{ user: AsanaUser; task: z.infer<typeof ownedTaskSchema> }> {
  const [userResult, taskResult] = await Promise.all([
    getMe(client),
    getTask(
      client,
      taskGid,
      "gid,name,modified_at,completed,due_on,due_at,start_on,assignee,assignee.gid,assignee.name,permalink_url",
    ),
  ]);
  const user = parseExternalData(userResult, userSchema, "UsersApi.getUser");
  const task = parseExternalData(taskResult, ownedTaskSchema, "TasksApi.getTask");
  if (task.assignee.gid !== user.gid) {
    throw new CliError(
      "Agent contract may update only tasks assigned to the authenticated user",
      2,
    );
  }
  return { user, task };
}

function agentResult(
  operation: string,
  effect: "read" | "prepare" | "write",
  data: unknown,
): unknown {
  return { operation, effect, policy: policy(), data };
}

function agentStatusUserProjection(user: AsanaUser): JsonObject {
  return {
    gid: user.gid,
    name: user.name,
    workspaces: user.workspaces,
  };
}

function gitSearchText(task: AsanaTask): string {
  const customFields = task.custom_fields?.map((field) =>
    field.display_value ?? field.text_value ?? ""
  ) ?? [];
  return [task.name, task.notes, ...customFields]
    .filter((entry): entry is string => typeof entry === "string")
    .join("\n");
}

function gitMatches(task: AsanaTask, query: string, contains: boolean): boolean {
  const text = gitSearchText(task);
  if (contains) return text.toLowerCase().includes(query.toLowerCase());
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}($|[^A-Za-z0-9])`, "i").test(text);
}

function agentTaskProjection(task: AsanaTask): JsonObject {
  const summary: JsonObject = { ...task };
  delete summary.notes;
  delete summary.html_notes;
  delete summary.custom_fields;
  return summary;
}

function taskList(value: unknown, context: string): AsanaTask[] {
  const parsed = taskListEnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    throw new CliError(`Invalid task list from ${context}: ${zodIssueSummary(parsed.error)}`, 1);
  }
  return parsed.data.data;
}

export async function runAgentCommand(
  client: AsanaClient,
  args: ParsedArgs,
): Promise<unknown> {
  const action = args.positionals[1];
  if (!action) throw new CliError("Missing agent action", 2);
  const inputFlag = stringFlag(args, "input");

  if (action === "status") {
    const user = parseExternalData(
      await getMe(client, AGENT_USER_FIELDS),
      userSchema,
      "UsersApi.getUser",
    );
    return agentResult("auth.status", "read", {
      authenticated: true,
      user: agentStatusUserProjection(user),
    });
  }

  if (action === "my-tasks") {
    const input = await readAgentJsonInput(inputFlag, myTasksInputSchema);
    const data = await getMyTasks(client, {
      workspace: input.workspace_gid,
      completed: input.completed,
      limit: input.limit,
      all: input.paginate,
      maxResults: input.max_results,
      fields: AGENT_TASK_FIELDS,
    });
    return agentResult("tasks.mine", "read", data);
  }

  if (action === "get-task") {
    const input = await readAgentJsonInput(inputFlag, getTaskInputSchema);
    const data = await getTask(
      client,
      input.task_gid,
      input.include_content ? TASK_FIELDS : AGENT_TASK_FIELDS,
    );
    return agentResult("task.get", "read", {
      task: parseExternalData(data, taskSchema, "TasksApi.getTask"),
      content_profile: input.include_content ? "full-untrusted" : "metadata",
    });
  }

  if (action === "list-comments") {
    const input = await readAgentJsonInput(inputFlag, listCommentsInputSchema);
    const data = await getTaskComments(client, input.task_gid, {
      limit: input.limit,
      all: input.paginate,
      maxResults: input.max_results,
      fields: STORY_FIELDS,
      allStories: false,
    });
    return agentResult("task.comments", "read", data);
  }

  if (action === "search-tasks" || action === "find-git") {
    const input = await readAgentJsonInput(inputFlag, searchInputSchema);
    const mine = !input.all_assignees;
    if (action === "search-tasks") {
      const data = await searchTasks(client, input.query, {
        workspace: input.workspace_gid,
        fields: AGENT_TASK_FIELDS,
        mine,
        completed: input.completed,
        all: false,
        maxResults: input.max_results,
      });
      return agentResult("task.search", "read", data);
    }

    try {
      const results = [await searchTasks(client, input.query, {
        workspace: input.workspace_gid,
        fields: TASK_FIELDS,
        mine,
        completed: input.completed,
        all: false,
        maxResults: input.max_results,
      })];
      if (input.field_gid) {
        const operator = input.contains ? "contains" : "value";
        results.push(await searchTasks(client, input.query, {
          workspace: input.workspace_gid,
          fields: TASK_FIELDS,
          mine,
          completed: input.completed,
          all: false,
          maxResults: input.max_results,
          includeText: false,
          extra: { [`custom_fields.${input.field_gid}.${operator}`]: input.query },
        }));
      }
      const found = new Map<string, JsonObject>();
      for (const result of results) {
        for (const task of taskList(result, "TasksApi.searchTasksForWorkspace")) {
          if (gitMatches(task, input.query, input.contains)) {
            found.set(task.gid, agentTaskProjection(task));
          }
        }
      }
      return agentResult("task.find-git", "read", {
        data: [...found.values()],
        meta: {
          query: input.query,
          exact_match: !input.contains,
          mode: "asana-search",
          count: found.size,
        },
      });
    } catch (error) {
      if (errorStatus(error) !== 402 || !mine) throw error;
      const scanned = await getMyTasks(client, {
        workspace: input.workspace_gid,
        completed: "all",
        limit: 100,
        all: true,
        maxResults: 500,
        fields: TASK_FIELDS,
      });
      const found = taskList(scanned, "TasksApi.getTasks")
        .filter((task) => gitMatches(task, input.query, input.contains))
        .map(agentTaskProjection);
      return agentResult("task.find-git", "read", {
        data: found,
        meta: {
          query: input.query,
          exact_match: !input.contains,
          mode: "local-scan-fallback",
          count: found.length,
          reason: "Asana advanced search requires Premium",
        },
      });
    }
  }

  if (action === "prepare-task-update") {
    const input = await readAgentJsonInput(inputFlag, prepareTaskUpdateInputSchema);
    ensureNoRegisteredSecret(input.patch, "Update");
    const { user, task } = await ownTask(client, input.task_gid);
    const unsignedPlan = {
      version: 1 as const,
      operation: "task.update" as const,
      task_gid: input.task_gid,
      expected_modified_at: task.modified_at,
      prepared_by: user.gid,
      target: { gid: task.gid, name: task.name, permalink_url: task.permalink_url },
      changes: input.patch,
    };
    const plan = taskUpdatePlanSchema.parse({ ...unsignedPlan, hash: planHash(unsignedPlan) });
    return agentResult("task.update.prepare", "prepare", {
      plan,
      approval: { required: true, reason: "This plan modifies one Asana task." },
    });
  }

  if (action === "apply-task-update") {
    const { plan } = await readAgentJsonInput(inputFlag, applyTaskUpdateInputSchema);
    verifyPlanHash(plan);
    ensureNoRegisteredSecret(plan.changes, "Update");
    const { user, task } = await ownTask(client, plan.task_gid);
    if (user.gid !== plan.prepared_by || task.modified_at !== plan.expected_modified_at) {
      throw new CliError("Task changed after the plan was prepared; prepare a new plan", 4);
    }
    const result = await updateTask(client, plan.task_gid, plan.changes, AGENT_TASK_FIELDS);
    return agentResult(
      "task.update.apply",
      "write",
      parseExternalData(result, taskSchema, "TasksApi.updateTask"),
    );
  }

  if (action === "prepare-comment") {
    const input = await readAgentJsonInput(inputFlag, prepareCommentInputSchema);
    ensureNoRegisteredSecret(input.text, "Comment");
    const { user, task } = await ownTask(client, input.task_gid);
    const unsignedPlan = {
      version: 1 as const,
      operation: "task.comment" as const,
      task_gid: input.task_gid,
      expected_modified_at: task.modified_at,
      prepared_by: user.gid,
      target: { gid: task.gid, name: task.name, permalink_url: task.permalink_url },
      text: input.text,
    };
    const plan = commentPlanSchema.parse({ ...unsignedPlan, hash: planHash(unsignedPlan) });
    return agentResult("task.comment.prepare", "prepare", {
      plan,
      approval: { required: true, reason: "This plan posts one Asana comment." },
    });
  }

  if (action === "apply-comment") {
    const { plan } = await readAgentJsonInput(inputFlag, applyCommentInputSchema);
    verifyPlanHash(plan);
    ensureNoRegisteredSecret(plan.text, "Comment");
    const { user, task } = await ownTask(client, plan.task_gid);
    if (user.gid !== plan.prepared_by || task.modified_at !== plan.expected_modified_at) {
      throw new CliError("Task changed after the plan was prepared; prepare a new plan", 4);
    }
    const result = await addTaskComment(client, plan.task_gid, { text: plan.text }, STORY_FIELDS);
    return agentResult(
      "task.comment.apply",
      "write",
      parseExternalData(result, storySchema, "StoriesApi.createStoryForTask"),
    );
  }

  throw new CliError(`Unknown agent action: ${action}`, 2);
}
