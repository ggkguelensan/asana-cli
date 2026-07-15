import { CliError } from "./errors";
import {
  asCollection,
  collectPages,
  invokeApiMethod,
  type CollectionLike,
} from "./sdk";

export const TASK_FIELDS = [
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
  "notes",
  "html_notes",
  "custom_fields",
  "custom_fields.gid",
  "custom_fields.name",
  "custom_fields.display_value",
  "memberships",
  "memberships.project.gid",
  "memberships.project.name",
  "memberships.section.gid",
  "memberships.section.name",
  "projects",
  "projects.gid",
  "projects.name",
  "tags",
  "tags.gid",
  "tags.name",
  "parent",
  "permalink_url",
  "created_at",
  "modified_at",
].join(",");

export const STORY_FIELDS = [
  "gid",
  "type",
  "resource_subtype",
  "text",
  "html_text",
  "created_at",
  "created_by",
  "created_by.gid",
  "created_by.name",
  "is_pinned",
  "is_edited",
].join(",");

export const AGENT_TASK_FIELDS = [
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
  "permalink_url",
  "modified_at",
].join(",");

interface Workspace {
  gid: string;
  name?: string;
}

interface CommandPageOptions {
  all: boolean;
  maxResults: number;
}

function envelopeData<T>(result: unknown, context: string): T {
  if (!result || typeof result !== "object" || !("data" in result)) {
    throw new CliError(`Unexpected response from ${context}`, 1);
  }
  return (result as { data: T }).data;
}

async function currentUser(client: any): Promise<any> {
  const result = await invokeApiMethod(client, "UsersApi", "getUser", ["me", {
    opt_fields: "gid,name,email,workspaces,workspaces.gid,workspaces.name",
  }]);
  return envelopeData(result, "UsersApi.getUser");
}

async function selectedWorkspaces(client: any, workspaceGid?: string): Promise<Workspace[]> {
  if (workspaceGid) return [{ gid: workspaceGid }];
  const user = await currentUser(client);
  const workspaces = Array.isArray(user?.workspaces) ? user.workspaces : [];
  if (!workspaces.length) {
    throw new CliError("The authenticated Asana user has no accessible workspaces", 4);
  }
  return workspaces;
}

export async function getMe(client: any): Promise<unknown> {
  return invokeApiMethod(client, "UsersApi", "getUser", ["me", {
    opt_fields: "gid,name,email,photo,workspaces,workspaces.gid,workspaces.name",
  }]);
}

export async function getWorkspaces(
  client: any,
  page: CommandPageOptions,
): Promise<unknown> {
  const result = await invokeApiMethod(client, "WorkspacesApi", "getWorkspaces", [{
    limit: Math.min(page.maxResults, 100),
    opt_fields: "gid,name,is_organization,email_domains",
  }]);
  return collectPages(asCollection(result, "WorkspacesApi.getWorkspaces"), page.all, page.maxResults);
}

export async function getMyTasks(
  client: any,
  options: CommandPageOptions & {
    workspace?: string;
    completed: "false" | "true" | "all";
    limit: number;
    fields: string;
    modifiedSince?: string;
  },
): Promise<unknown> {
  const workspaces = await selectedWorkspaces(client, options.workspace);
  const data: unknown[] = [];
  const pages: Array<Record<string, unknown>> = [];

  for (const workspace of workspaces) {
    const common = {
      opt_fields: options.fields,
      ...(options.modifiedSince ? { modified_since: options.modifiedSince } : {}),
    };
    let result: unknown;
    result = await invokeApiMethod(client, "TasksApi", "getTasks", [{
      ...common,
      limit: options.limit,
      assignee: "me",
      workspace: workspace.gid,
      ...(options.completed === "false" ? { completed_since: "now" } : {}),
    }]);
    const remaining = Math.max(options.maxResults - data.length, 0);
    if (remaining === 0) break;
    const collected = await collectPages(
      asCollection(result, "TasksApi task listing"),
      options.all || options.completed === "true",
      remaining,
    );
    const selected = options.completed === "true"
      ? collected.data.filter((task: any) => task?.completed === true)
      : collected.data;
    data.push(...selected);
    pages.push({
      workspace: workspace.gid,
      ...(workspace.name ? { workspace_name: workspace.name } : {}),
      count: selected.length,
      next_page: collected.next_page,
    });
  }

  return {
    data,
    meta: {
      count: data.length,
      completed: options.completed,
      workspaces: pages,
      truncated: data.length >= options.maxResults,
    },
  };
}

export async function getTask(client: any, gid: string, fields: string): Promise<unknown> {
  return invokeApiMethod(client, "TasksApi", "getTask", [gid, { opt_fields: fields }]);
}

export async function getTaskComments(
  client: any,
  gid: string,
  options: CommandPageOptions & { limit: number; fields: string; allStories: boolean },
): Promise<unknown> {
  const result = await invokeApiMethod(client, "StoriesApi", "getStoriesForTask", [gid, {
    limit: options.limit,
    opt_fields: options.fields,
  }]);
  const collected = await collectPages(
    asCollection(result, "StoriesApi.getStoriesForTask"),
    options.all,
    options.maxResults,
  );
  const stories = options.allStories
    ? collected.data
    : collected.data.filter((story: any) =>
        story?.type === "comment" || String(story?.resource_subtype ?? "").includes("comment"),
      );
  return {
    data: stories,
    next_page: collected.next_page,
    meta: { count: stories.length, task_gid: gid, all_stories: options.allStories },
  };
}

export async function updateTask(
  client: any,
  gid: string,
  data: Record<string, unknown>,
  fields: string,
): Promise<unknown> {
  if (!Object.keys(data).length) {
    throw new CliError(
      "No updates supplied. Use --data JSON or task fields such as --name/--completed/--due-on.",
      2,
    );
  }
  return invokeApiMethod(client, "TasksApi", "updateTask", [
    { data },
    gid,
    { opt_fields: fields },
  ]);
}

export async function addTaskComment(
  client: any,
  gid: string,
  content: { text?: string; html_text?: string },
  fields: string,
): Promise<unknown> {
  const value = content.text ?? content.html_text;
  if (!value?.trim()) throw new CliError("Comment text must not be empty", 2);
  return invokeApiMethod(client, "StoriesApi", "createStoryForTask", [
    { data: content },
    gid,
    { opt_fields: fields },
  ]);
}

export async function searchTasks(
  client: any,
  query: string,
  options: CommandPageOptions & {
    workspace?: string;
    fields: string;
    mine: boolean;
    completed?: boolean;
    extra?: Record<string, unknown>;
    includeText?: boolean;
  },
): Promise<unknown> {
  if (!query.trim()) throw new CliError("Search query must not be empty", 2);
  const workspaces = await selectedWorkspaces(client, options.workspace);
  const data: unknown[] = [];
  const pages: Array<Record<string, unknown>> = [];

  for (const workspace of workspaces) {
    const remaining = Math.max(options.maxResults - data.length, 0);
    if (remaining === 0) break;
    const result = await invokeApiMethod(client, "TasksApi", "searchTasksForWorkspace", [
      workspace.gid,
      {
        ...(options.includeText === false ? {} : { text: query }),
        opt_fields: options.fields,
        ...(options.mine ? { "assignee.any": "me" } : {}),
        ...(options.completed === undefined ? {} : { completed: options.completed }),
        ...options.extra,
      },
    ]);
    const collected = await collectPages(
      asCollection(result, "TasksApi.searchTasksForWorkspace"),
      options.all,
      remaining,
    );
    data.push(...collected.data);
    pages.push({
      workspace: workspace.gid,
      ...(workspace.name ? { workspace_name: workspace.name } : {}),
      count: collected.data.length,
      next_page: collected.next_page,
    });
  }

  return {
    data,
    meta: {
      query,
      mine: options.mine,
      count: data.length,
      workspaces: pages,
      truncated: data.length >= options.maxResults,
    },
  };
}

export function collectionResponse(value: unknown): value is CollectionLike {
  return Boolean(value && typeof value === "object" && Array.isArray((value as any).data));
}
