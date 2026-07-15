import { createHash } from "node:crypto";
import { stringFlag, type ParsedArgs } from "./args";
import {
  addTaskComment,
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
import { CliError } from "./errors";
import { errorStatus } from "./errors";
import { readAgentJsonInput } from "./io";
import { containsRegisteredSecret } from "./security";

type JsonObject = Record<string, unknown>;

const POLICY = () => process.env.ASANA_CLI_AGENT_POLICY === "read-write" ? "read-write" : "read";

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError(`${label} must be a JSON object`, 2);
  }
  return value as JsonObject;
}

function onlyKeys(value: JsonObject, allowed: string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new CliError(`${label} contains unknown fields: ${unknown.join(", ")}`, 2);
}

function requiredString(value: JsonObject, key: string, maximum = 10_000): string {
  const result = value[key];
  if (typeof result !== "string" || !result.trim()) {
    throw new CliError(`${key} must be a non-empty string`, 2);
  }
  if (result.length > maximum) throw new CliError(`${key} exceeds ${maximum} characters`, 2);
  return result;
}

function optionalString(value: JsonObject, key: string, maximum = 10_000): string | undefined {
  const result = value[key];
  if (result === undefined) return undefined;
  if (typeof result !== "string" || result.length > maximum) {
    throw new CliError(`${key} must be a string of at most ${maximum} characters`, 2);
  }
  return result;
}

function gid(value: JsonObject, key: string): string {
  const result = requiredString(value, key, 64);
  if (!/^\d{1,64}$/.test(result)) throw new CliError(`${key} must be a numeric Asana GID`, 2);
  return result;
}

function optionalGid(value: JsonObject, key: string): string | undefined {
  if (value[key] === undefined) return undefined;
  return gid(value, key);
}

function positiveInteger(value: JsonObject, key: string, fallback: number, maximum: number): number {
  const result = value[key] ?? fallback;
  if (!Number.isInteger(result) || Number(result) < 1 || Number(result) > maximum) {
    throw new CliError(`${key} must be an integer between 1 and ${maximum}`, 2);
  }
  return Number(result);
}

function boolean(value: JsonObject, key: string, fallback = false): boolean {
  const result = value[key] ?? fallback;
  if (typeof result !== "boolean") throw new CliError(`${key} must be a boolean`, 2);
  return result;
}

function envelopeData(value: unknown, label: string): any {
  if (!value || typeof value !== "object" || !("data" in value)) {
    throw new CliError(`Unexpected response from ${label}`, 1);
  }
  return (value as any).data;
}

function stable(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map((entry) => stable(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as JsonObject).filter((key) => (value as JsonObject)[key] !== undefined).sort().map((key) =>
      `${JSON.stringify(key)}:${stable((value as JsonObject)[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function planHash(plan: JsonObject): string {
  const unsigned = Object.fromEntries(Object.entries(plan).filter(([key]) => key !== "hash"));
  return `sha256:${createHash("sha256").update(stable(unsigned)).digest("hex")}`;
}

function verifyPlan(plan: JsonObject, operation: string): void {
  if (plan.version !== 1 || plan.operation !== operation || typeof plan.hash !== "string") {
    throw new CliError(`Invalid ${operation} plan`, 2);
  }
  if (plan.hash !== planHash(plan)) throw new CliError("Plan hash mismatch", 2);
  if (typeof plan.task_gid !== "string" || !/^\d{1,64}$/.test(plan.task_gid)) {
    throw new CliError("Plan contains an invalid task GID", 2);
  }
  if (typeof plan.prepared_by !== "string" || typeof plan.expected_modified_at !== "string") {
    throw new CliError("Plan is missing concurrency guard fields", 2);
  }
}

function validatePatch(value: unknown): JsonObject {
  const patch = object(value, "patch");
  onlyKeys(
    patch,
    ["name", "notes", "completed", "assignee", "due_on", "due_at", "start_on", "custom_fields"],
    "patch",
  );
  if (!Object.keys(patch).length) throw new CliError("patch must not be empty", 2);
  if (patch.name !== undefined && (typeof patch.name !== "string" || patch.name.length > 500)) {
    throw new CliError("patch.name must be a string of at most 500 characters", 2);
  }
  if (patch.notes !== undefined && (typeof patch.notes !== "string" || patch.notes.length > 8_000)) {
    throw new CliError("patch.notes must be a string of at most 8000 characters", 2);
  }
  if (patch.completed !== undefined && typeof patch.completed !== "boolean") {
    throw new CliError("patch.completed must be a boolean", 2);
  }
  if (patch.assignee !== undefined && patch.assignee !== "me") {
    throw new CliError("Agent contract permits only assignee='me'", 2);
  }
  for (const key of ["due_on", "due_at", "start_on"]) {
    if (patch[key] !== undefined && patch[key] !== null && typeof patch[key] !== "string") {
      throw new CliError(`patch.${key} must be a string or null`, 2);
    }
  }
  if (patch.due_on != null && patch.due_at != null) {
    throw new CliError("patch cannot set due_on and due_at together", 2);
  }
  if (patch.custom_fields !== undefined) {
    const customFields = object(patch.custom_fields, "patch.custom_fields");
    if (Object.keys(customFields).length > 50) throw new CliError("Too many custom field updates", 2);
    for (const [fieldGid, fieldValue] of Object.entries(customFields)) {
      if (!/^\d{1,64}$/.test(fieldGid)) throw new CliError(`Invalid custom field GID: ${fieldGid}`, 2);
      const valid = fieldValue === null || ["string", "number", "boolean"].includes(typeof fieldValue) ||
        Array.isArray(fieldValue) && fieldValue.every((entry) => typeof entry === "string");
      if (!valid) throw new CliError(`Unsupported value for custom field ${fieldGid}`, 2);
    }
  }
  if (containsRegisteredSecret(patch)) {
    throw new CliError("Update blocked because it contains a credential from the local environment", 2);
  }
  return patch;
}

async function ownTask(client: any, taskGid: string): Promise<{ user: any; task: any }> {
  const [userResult, taskResult] = await Promise.all([
    getMe(client),
    getTask(client, taskGid, "gid,name,modified_at,completed,due_on,due_at,start_on,assignee,assignee.gid,assignee.name,permalink_url"),
  ]);
  const user = envelopeData(userResult, "UsersApi.getUser");
  const task = envelopeData(taskResult, "TasksApi.getTask");
  if (task?.assignee?.gid !== user?.gid) {
    throw new CliError("Agent contract may update only tasks assigned to the authenticated user", 2);
  }
  return { user, task };
}

function agentResult(operation: string, effect: "read" | "prepare" | "write", data: unknown): unknown {
  return {
    operation,
    effect,
    policy: POLICY(),
    data,
  };
}

function agentUserProjection(user: any): any {
  return {
    gid: user?.gid,
    name: user?.name,
    email: user?.email,
    workspaces: user?.workspaces,
  };
}

function gitSearchText(task: any): string {
  const customFields = Array.isArray(task?.custom_fields)
    ? task.custom_fields.map((field: any) => field?.display_value ?? field?.text_value ?? "")
    : [];
  return [task?.name, task?.notes, ...customFields].filter((entry) => typeof entry === "string").join("\n");
}

function gitMatches(task: any, query: string, contains: boolean): boolean {
  const text = gitSearchText(task);
  if (contains) return text.toLowerCase().includes(query.toLowerCase());
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}($|[^A-Za-z0-9])`, "i").test(text);
}

function agentTaskProjection(task: any): any {
  const { notes: _notes, html_notes: _htmlNotes, custom_fields: _customFields, ...summary } = task;
  return summary;
}

export async function runAgentCommand(
  client: any,
  args: ParsedArgs,
): Promise<unknown> {
  const action = args.positionals[1];
  if (!action) throw new CliError("Missing agent action", 2);
  const input = action === "status"
    ? {}
    : object(await readAgentJsonInput(stringFlag(args, "input")), "agent input");

  if (action === "status") {
    const user = envelopeData(await getMe(client), "UsersApi.getUser");
    return agentResult("auth.status", "read", {
      authenticated: true,
      user: agentUserProjection(user),
    });
  }
  if (action === "my-tasks") {
    onlyKeys(input, ["workspace_gid", "completed", "limit", "paginate", "max_results"], "input");
    const completed = input.completed ?? "false";
    if (!["false", "true", "all"].includes(String(completed))) {
      throw new CliError("completed must be false, true, or all", 2);
    }
    const data = await getMyTasks(client, {
      workspace: optionalGid(input, "workspace_gid"),
      completed: String(completed) as "false" | "true" | "all",
      limit: positiveInteger(input, "limit", 50, 100),
      all: boolean(input, "paginate", false),
      maxResults: positiveInteger(input, "max_results", 100, 500),
      fields: AGENT_TASK_FIELDS,
    });
    return agentResult("tasks.mine", "read", data);
  }
  if (action === "get-task") {
    onlyKeys(input, ["task_gid", "include_content"], "input");
    const includeContent = boolean(input, "include_content", false);
    const data = await getTask(client, gid(input, "task_gid"), includeContent ? TASK_FIELDS : AGENT_TASK_FIELDS);
    return agentResult("task.get", "read", {
      task: envelopeData(data, "TasksApi.getTask"),
      content_profile: includeContent ? "full-untrusted" : "metadata",
    });
  }
  if (action === "list-comments") {
    onlyKeys(input, ["task_gid", "limit", "paginate", "max_results"], "input");
    const data = await getTaskComments(client, gid(input, "task_gid"), {
      limit: positiveInteger(input, "limit", 50, 100),
      all: boolean(input, "paginate", false),
      maxResults: positiveInteger(input, "max_results", 100, 500),
      fields: STORY_FIELDS,
      allStories: false,
    });
    return agentResult("task.comments", "read", data);
  }
  if (action === "search-tasks" || action === "find-git") {
    onlyKeys(
      input,
      ["query", "workspace_gid", "all_assignees", "completed", "max_results", "field_gid", "contains"],
      "input",
    );
    const completed = input.completed;
    if (completed !== undefined && typeof completed !== "boolean") {
      throw new CliError("completed must be a boolean", 2);
    }
    const query = requiredString(input, "query", 500);
    const workspace = optionalGid(input, "workspace_gid");
    const mine = !boolean(input, "all_assignees", false);
    const maxResults = positiveInteger(input, "max_results", 100, 100);
    if (action === "search-tasks") {
      const data = await searchTasks(client, query, {
        workspace,
        fields: AGENT_TASK_FIELDS,
        mine,
        completed,
        all: false,
        maxResults,
      });
      return agentResult("task.search", "read", data);
    }

    const contains = boolean(input, "contains", false);
    const fieldGid = optionalGid(input, "field_gid");
    try {
      const results = [await searchTasks(client, query, {
        workspace,
        fields: TASK_FIELDS,
        mine,
        completed,
        all: false,
        maxResults,
      })];
      if (fieldGid) {
        results.push(await searchTasks(client, query, {
          workspace,
          fields: TASK_FIELDS,
          mine,
          completed,
          all: false,
          maxResults,
          includeText: false,
          extra: { [`custom_fields.${fieldGid}.${contains ? "contains" : "value"}`]: query },
        }));
      }
      const found = new Map<string, any>();
      for (const result of results) {
        for (const task of Array.isArray((result as any)?.data) ? (result as any).data : []) {
          if (gitMatches(task, query, contains)) found.set(String(task.gid), agentTaskProjection(task));
        }
      }
      return agentResult("task.find-git", "read", {
        data: [...found.values()],
        meta: { query, exact_match: !contains, mode: "asana-search", count: found.size },
      });
    } catch (error) {
      if (errorStatus(error) !== 402 || !mine) throw error;
      const scanned = await getMyTasks(client, {
        workspace,
        completed: "all",
        limit: 100,
        all: true,
        maxResults: 500,
        fields: TASK_FIELDS,
      });
      const tasks = Array.isArray((scanned as any)?.data) ? (scanned as any).data : [];
      const found = tasks.filter((task: any) => gitMatches(task, query, contains)).map(agentTaskProjection);
      return agentResult("task.find-git", "read", {
        data: found,
        meta: {
          query,
          exact_match: !contains,
          mode: "local-scan-fallback",
          count: found.length,
          reason: "Asana advanced search requires Premium",
        },
      });
    }
  }
  if (action === "prepare-task-update") {
    onlyKeys(input, ["task_gid", "patch"], "input");
    const taskGid = gid(input, "task_gid");
    const changes = validatePatch(input.patch);
    const { user, task } = await ownTask(client, taskGid);
    const plan: JsonObject = {
      version: 1,
      operation: "task.update",
      task_gid: taskGid,
      expected_modified_at: task.modified_at,
      prepared_by: user.gid,
      target: { gid: task.gid, name: task.name, permalink_url: task.permalink_url },
      changes,
    };
    plan.hash = planHash(plan);
    return agentResult("task.update.prepare", "prepare", {
      plan,
      approval: { required: true, reason: "This plan modifies one Asana task." },
    });
  }
  if (action === "apply-task-update") {
    onlyKeys(input, ["plan"], "input");
    const plan = object(input.plan, "plan");
    verifyPlan(plan, "task.update");
    const taskGid = String(plan.task_gid);
    const { user, task } = await ownTask(client, taskGid);
    if (user.gid !== plan.prepared_by || task.modified_at !== plan.expected_modified_at) {
      throw new CliError("Task changed after the plan was prepared; prepare a new plan", 4);
    }
    const changes = validatePatch(plan.changes);
    const result = await updateTask(client, taskGid, changes, AGENT_TASK_FIELDS);
    return agentResult("task.update.apply", "write", envelopeData(result, "TasksApi.updateTask"));
  }
  if (action === "prepare-comment") {
    onlyKeys(input, ["task_gid", "text"], "input");
    const taskGid = gid(input, "task_gid");
    const text = requiredString(input, "text", 8_000);
    if (containsRegisteredSecret(text)) {
      throw new CliError("Comment blocked because it contains a credential from the local environment", 2);
    }
    const { user, task } = await ownTask(client, taskGid);
    const plan: JsonObject = {
      version: 1,
      operation: "task.comment",
      task_gid: taskGid,
      expected_modified_at: task.modified_at,
      prepared_by: user.gid,
      target: { gid: task.gid, name: task.name, permalink_url: task.permalink_url },
      text,
    };
    plan.hash = planHash(plan);
    return agentResult("task.comment.prepare", "prepare", {
      plan,
      approval: { required: true, reason: "This plan posts one Asana comment." },
    });
  }
  if (action === "apply-comment") {
    onlyKeys(input, ["plan"], "input");
    const plan = object(input.plan, "plan");
    verifyPlan(plan, "task.comment");
    const taskGid = String(plan.task_gid);
    const { user, task } = await ownTask(client, taskGid);
    if (user.gid !== plan.prepared_by || task.modified_at !== plan.expected_modified_at) {
      throw new CliError("Task changed after the plan was prepared; prepare a new plan", 4);
    }
    const text = typeof plan.text === "string" ? plan.text : "";
    if (!text || text.length > 8_000) throw new CliError("Invalid comment text in plan", 2);
    if (containsRegisteredSecret(text)) {
      throw new CliError("Comment blocked because it contains a credential from the local environment", 2);
    }
    const result = await addTaskComment(client, taskGid, { text }, STORY_FIELDS);
    return agentResult("task.comment.apply", "write", envelopeData(result, "StoriesApi.createStoryForTask"));
  }

  throw new CliError(`Unknown agent action: ${action}`, 2);
}
