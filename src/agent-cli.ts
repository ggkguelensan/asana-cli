import { createHash } from "node:crypto";
import { z } from "zod";
import {
  commentPlanSchema,
  taskUpdatePlanSchema,
} from "./agent-action-schemas";
import {
  createAgentActionResult,
  readAgentActionInput,
  type AgentActionName,
} from "./agent-contract";
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
import {
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
  if (plan.hash !== planHash(plan)) throw new CliError("validation", "Plan hash mismatch");
}

export function assertPreparedTaskIsCurrent(
  currentUserGid: string,
  currentModifiedAt: string,
  preparedBy: string,
  expectedModifiedAt: string,
): void {
  if (currentUserGid !== preparedBy || currentModifiedAt !== expectedModifiedAt) {
    throw new CliError(
      "stale-or-expired",
      "Task changed after the plan was prepared; prepare a new plan",
    );
  }
}

function ensureNoRegisteredSecret(value: unknown, operation: string): void {
  if (containsRegisteredSecret(value)) {
    throw new CliError(
      "policy-denied",
      `${operation} blocked because it contains a credential from the local environment`,
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
      "policy-denied",
      "Agent contract may update only tasks assigned to the authenticated user",
    );
  }
  return { user, task };
}

function agentResult(
  action: AgentActionName,
  data: unknown,
): unknown {
  return createAgentActionResult(action, policy(), data);
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
    throw new CliError(
      "internal",
      `Invalid task list from ${context}: ${zodIssueSummary(parsed.error)}`,
    );
  }
  return parsed.data.data;
}

export async function runAgentCommand(
  client: AsanaClient,
  args: ParsedArgs,
): Promise<unknown> {
  const action = args.positionals[1];
  if (!action) throw new CliError("usage", "Missing agent action");
  const inputFlag = stringFlag(args, "input");

  if (action === "status") {
    const user = parseExternalData(
      await getMe(client, AGENT_USER_FIELDS),
      userSchema,
      "UsersApi.getUser",
    );
    return agentResult("status", {
      authenticated: true,
      user: agentStatusUserProjection(user),
    });
  }

  if (action === "my-tasks") {
    const input = await readAgentActionInput(inputFlag, "my-tasks");
    const data = await getMyTasks(client, {
      workspace: input.workspace_gid,
      completed: input.completed,
      limit: input.limit,
      all: input.paginate,
      maxResults: input.max_results,
      fields: AGENT_TASK_FIELDS,
    });
    return agentResult("my-tasks", data);
  }

  if (action === "get-task") {
    const input = await readAgentActionInput(inputFlag, "get-task");
    const data = await getTask(
      client,
      input.task_gid,
      input.include_content ? TASK_FIELDS : AGENT_TASK_FIELDS,
    );
    return agentResult("get-task", {
      task: parseExternalData(data, taskSchema, "TasksApi.getTask"),
      content_profile: input.include_content ? "full-untrusted" : "metadata",
    });
  }

  if (action === "list-comments") {
    const input = await readAgentActionInput(inputFlag, "list-comments");
    const data = await getTaskComments(client, input.task_gid, {
      limit: input.limit,
      all: input.paginate,
      maxResults: input.max_results,
      fields: STORY_FIELDS,
      allStories: false,
    });
    return agentResult("list-comments", data);
  }

  if (action === "search-tasks" || action === "find-git") {
    const input = await readAgentActionInput(inputFlag, action);
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
      return agentResult("search-tasks", data);
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
      return agentResult("find-git", {
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
      return agentResult("find-git", {
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
    const input = await readAgentActionInput(inputFlag, "prepare-task-update");
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
    return agentResult("prepare-task-update", {
      plan,
      approval: { required: true, reason: "This plan modifies one Asana task." },
    });
  }

  if (action === "apply-task-update") {
    const { plan } = await readAgentActionInput(inputFlag, "apply-task-update");
    verifyPlanHash(plan);
    ensureNoRegisteredSecret(plan.changes, "Update");
    const { user, task } = await ownTask(client, plan.task_gid);
    assertPreparedTaskIsCurrent(
      user.gid,
      task.modified_at,
      plan.prepared_by,
      plan.expected_modified_at,
    );
    const result = await updateTask(client, plan.task_gid, plan.changes, AGENT_TASK_FIELDS);
    return agentResult(
      "apply-task-update",
      parseExternalData(result, taskSchema, "TasksApi.updateTask"),
    );
  }

  if (action === "prepare-comment") {
    const input = await readAgentActionInput(inputFlag, "prepare-comment");
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
    return agentResult("prepare-comment", {
      plan,
      approval: { required: true, reason: "This plan posts one Asana comment." },
    });
  }

  if (action === "apply-comment") {
    const { plan } = await readAgentActionInput(inputFlag, "apply-comment");
    verifyPlanHash(plan);
    ensureNoRegisteredSecret(plan.text, "Comment");
    const { user, task } = await ownTask(client, plan.task_gid);
    assertPreparedTaskIsCurrent(
      user.gid,
      task.modified_at,
      plan.prepared_by,
      plan.expected_modified_at,
    );
    const result = await addTaskComment(client, plan.task_gid, { text: plan.text }, STORY_FIELDS);
    return agentResult(
      "apply-comment",
      parseExternalData(result, storySchema, "StoriesApi.createStoryForTask"),
    );
  }

  throw new CliError("usage", `Unknown agent action: ${action}`);
}
