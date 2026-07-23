import { z } from "zod";
import {
  DEFAULT_AGENT_CONTENT_BYTES,
  getTaskInputSchema,
  TASK_INCLUDE_SELECTORS,
  type TaskIncludeSelector,
} from "./agent-action-schemas";
import {
  createAgentActionResult,
  type AgentActionName,
} from "./agent-contract";
import {
  readApplyAgentInput,
  readDirectAgentInput,
  readGitCurrentAgentInput,
  readGitCurrentCandidatesAgentInput,
  readPrepareCommentAgentInput,
  readOperationStatusAgentInput,
  readRepositoryAsanaAgentInput,
  readRepositoryContextAgentInput,
  readStdinAgentInput,
  readTaskContextAgentInput,
} from "./agent-input";
import { readCurrentGitContext } from "./git-context";
import { findGitCurrentCandidates } from "./git-current-candidates";
import { rejectDeprecatedLegacyAgentApply } from "./agent-deprecations";
import { AgentOperationService } from "./agent-operations";
import type { MetadataAuditStore } from "./audit/repository";
import type { HostScopedWritePolicyProvider } from "./host-write-policy";
import { type ParsedArgs } from "./args";
import {
  FixedFileRepositoryAsanaMappingProvider,
  type RepositoryAsanaMappingProvider,
} from "./repository-asana-mapping";
import {
  FixedFileRepositoryContextManifestProvider,
  type RepositoryContextManifestProvider,
} from "./repository-context";
import {
  AGENT_USER_FIELDS,
  AGENT_TASK_FIELDS,
  getMe,
  getMyTasks,
  getTask,
  getTaskComments,
  searchTasks,
  STORY_FIELDS,
  TASK_FIELDS,
} from "./asana-commands";
import { CliError, errorStatus } from "./errors";
import {
  projectComments,
  projectTaskCollection,
  selectedTaskProjection,
  taskMetadataProjection,
} from "./agent-projections";
import { ContentBudget } from "./content-budget";
import {
  parseExternalData,
  taskListEnvelopeSchema,
  taskSchema,
  userSchema,
  zodIssueSummary,
  type AsanaTask,
  type AsanaUser,
} from "./schemas";
import { type AsanaClient } from "./sdk";
import type { OperationRepository } from "./operations/repository";
import { operationStatusProjection } from "./operations/status-projection";
import {
  getCustomFieldContext,
  listCustomFieldsContext,
  listProjectMembershipsContext,
  listProjectsContext,
  listSectionsContext,
  resolveUserContext,
} from "./developer-context";
import { getTaskContext } from "./task-context";
import { resolveTaskReference } from "./task-reference";

type JsonObject = Record<string, unknown>;

const agentEnvironmentSchema = z.object({
  ASANA_CLI_AGENT_POLICY: z.enum(["read", "read-write"]).optional().catch(undefined),
});

function policy(): "read" | "read-write" {
  return agentEnvironmentSchema.parse(process.env).ASANA_CLI_AGENT_POLICY ?? "read";
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
  return taskMetadataProjection(task);
}

const taskIncludeFields = {
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

function selectedTaskFields(includes: readonly TaskIncludeSelector[]): string {
  const fields = new Set(AGENT_TASK_FIELDS.split(","));
  for (const include of includes) {
    for (const field of taskIncludeFields[include]) fields.add(field);
  }
  return [...fields].join(",");
}

function normalizedTaskSelection(input: z.output<typeof getTaskInputSchema>): {
  includes: TaskIncludeSelector[];
  maximumContentBytes: number;
  contentProfile: "metadata" | "selected-untrusted" | "full-untrusted";
} {
  if ("include_content" in input) {
    return {
      includes: input.include_content ? [...TASK_INCLUDE_SELECTORS] : [],
      maximumContentBytes: input.max_content_bytes ?? DEFAULT_AGENT_CONTENT_BYTES,
      contentProfile: input.include_content ? "full-untrusted" : "metadata",
    };
  }
  const includes = [...new Set(input.include)];
  return {
    includes,
    maximumContentBytes: input.max_content_bytes,
    contentProfile: includes.length > 0 ? "selected-untrusted" : "metadata",
  };
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
  runtime: AgentCommandRuntime,
): Promise<unknown> {
  const action = args.positionals[1];
  if (!action) throw new CliError("usage", "Missing agent action");
  rejectDeprecatedLegacyAgentApply(action);

  if (action === "operation") return runLocalAgentCommand(args, runtime);


  if (action === "context") {
    if (Object.hasOwn(args.flags, "task")) {
      const input = readTaskContextAgentInput(args);
      return agentResult(
        "task-context",
        await getTaskContext(client, input),
      );
    }
    const input = readGitCurrentCandidatesAgentInput(args);
    const context = await readCurrentGitContext();
    return agentResult("git-current-candidates", await findGitCurrentCandidates(client, input, context));
  }
  if (action === "status") {
    await readDirectAgentInput(args, "status");
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
    const input = await readDirectAgentInput(args, "my-tasks");
    const data = await getMyTasks(client, {
      workspace: input.workspace_gid,
      completed: input.completed,
      limit: input.limit,
      all: input.paginate,
      maxResults: input.max_results,
      fields: AGENT_TASK_FIELDS,
    });
    return agentResult("my-tasks", projectTaskCollection(data, "TasksApi.getTasks"));
  }

  if (action === "list-projects") {
    const input = await readDirectAgentInput(args, "list-projects");
    return agentResult("list-projects", await listProjectsContext(client, input));
  }

  if (action === "list-sections") {
    const input = await readDirectAgentInput(args, "list-sections");
    return agentResult("list-sections", await listSectionsContext(client, input));
  }

  if (action === "list-project-memberships") {
    const input = await readDirectAgentInput(args, "list-project-memberships");
    return agentResult(
      "list-project-memberships",
      await listProjectMembershipsContext(client, input),
    );
  }

  if (action === "list-custom-fields") {
    const input = await readDirectAgentInput(args, "list-custom-fields");
    return agentResult(
      "list-custom-fields",
      await listCustomFieldsContext(client, input),
    );
  }

  if (action === "get-custom-field") {
    const input = await readDirectAgentInput(args, "get-custom-field");
    return agentResult(
      "get-custom-field",
      await getCustomFieldContext(client, input),
    );
  }

  if (action === "resolve-user") {
    const input = await readDirectAgentInput(args, "resolve-user");
    return agentResult("resolve-user", await resolveUserContext(client, input));
  }

  if (action === "resolve-task") {
    const input = await readDirectAgentInput(args, "resolve-task");
    return agentResult(
      "resolve-task",
      await resolveTaskReference(client, input.reference, {
        repositoryContext: runtime.repositoryContext,
      }),
    );
  }

  if (action === "get-task") {
    const input = await readDirectAgentInput(args, "get-task");
    const selection = normalizedTaskSelection(input);
    const data = await getTask(
      client,
      input.task_gid,
      selectedTaskFields(selection.includes),
    );
    const task = parseExternalData(data, taskSchema, "TasksApi.getTask");
    const budget = new ContentBudget(selection.maximumContentBytes);
    return agentResult("get-task", {
      task: selectedTaskProjection(task, selection.includes, budget),
      content_profile: selection.contentProfile,
      content_budget: budget.metadata(),
    });
  }

  if (action === "list-comments") {
    const input = await readDirectAgentInput(args, "list-comments");
    const data = await getTaskComments(client, input.task_gid, {
      limit: input.limit,
      all: input.paginate,
      maxResults: input.max_results,
      fields: STORY_FIELDS,
      allStories: false,
    });
    return agentResult(
      "list-comments",
      projectComments(data, input.max_content_bytes),
    );
  }

  if (action === "search-tasks" || action === "find-git") {
    const input = action === "search-tasks"
      ? await readDirectAgentInput(args, "search-tasks")
      : await readDirectAgentInput(args, "find-git");
    const mine = !input.all_assignees;
    const fieldGid = "field_gid" in input && typeof input.field_gid === "string"
      ? input.field_gid
      : undefined;
    const contains = "contains" in input && input.contains === true;
    if (action === "search-tasks") {
      const data = await searchTasks(client, input.query, {
        workspace: input.workspace_gid,
        fields: AGENT_TASK_FIELDS,
        mine,
        completed: input.completed,
        all: false,
        maxResults: input.max_results,
      });
      return agentResult(
        "search-tasks",
        projectTaskCollection(data, "TasksApi.searchTasksForWorkspace"),
      );
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
      if (fieldGid) {
        const operator = contains ? "contains" : "value";
        results.push(await searchTasks(client, input.query, {
          workspace: input.workspace_gid,
          fields: TASK_FIELDS,
          mine,
          completed: input.completed,
          all: false,
          maxResults: input.max_results,
          includeText: false,
          extra: { [`custom_fields.${fieldGid}.${operator}`]: input.query },
        }));
      }
      const found = new Map<string, JsonObject>();
      let reachedResultLimit = false;
      findMatches: {
        for (const result of results) {
          for (const task of taskList(result, "TasksApi.searchTasksForWorkspace")) {
            if (gitMatches(task, input.query, contains) && !found.has(task.gid)) {
              found.set(task.gid, agentTaskProjection(task));
              if (found.size >= input.max_results) {
                reachedResultLimit = true;
                break findMatches;
              }
            }
          }
        }
      }
      return agentResult("find-git", {
        data: [...found.values()],
        meta: {
          query: input.query,
          exact_match: !contains,
          mode: "asana-search",
          count: found.size,
          truncated: reachedResultLimit,
        },
      });
    } catch (error) {
      if (errorStatus(error) !== 402 || !mine) throw error;
      const scanned = await getMyTasks(client, {
        workspace: input.workspace_gid,
        completed: "all",
        limit: 100,
        all: true,
        maxResults: input.max_results,
        fields: TASK_FIELDS,
      });
      const found = taskList(scanned, "TasksApi.getTasks")
        .filter((task) => gitMatches(task, input.query, contains))
        .map(agentTaskProjection);
      return agentResult("find-git", {
        data: found,
        meta: {
          query: input.query,
          exact_match: !contains,
          mode: "local-scan-fallback",
          count: found.length,
          reason: "Asana advanced search requires Premium",
        },
      });
    }
  }
  if (action === "prepare-task-update") {
    const input = await readStdinAgentInput(args, "prepare-task-update");
    const service = new AgentOperationService(client, runtime.operations, runtime);
    return agentResult("prepare-task-update", await service.prepareTaskUpdate(input));
  }

  if (action === "prepare-comment") {
    const input = await readPrepareCommentAgentInput(args);
    const service = new AgentOperationService(client, runtime.operations, runtime);
    return agentResult("prepare-comment", await service.prepareComment(input));
  }

  if (action === "apply") {
    if (policy() !== "read-write") {
      throw new CliError(
        "policy-denied",
        "Agent writes are disabled. Start the agent host with ASANA_CLI_AGENT_POLICY=read-write; host approval is still required.",
      );
    }
    const input = await readApplyAgentInput(args);
    const service = new AgentOperationService(client, runtime.operations, runtime);
    return agentResult("apply", await service.apply(input.operation_id));
  }

  throw new CliError("usage", `Unknown agent action: ${action}`);
}

/** Executes agent operations that inspect only local state and require no SDK client. */
export async function runLocalAgentCommand(
  args: ParsedArgs,
  runtime: LocalAgentCommandRuntime,
): Promise<unknown> {
  if (args.positionals[1] === "context") {
    if (Object.hasOwn(args.flags, "repository-context")) {
      readRepositoryContextAgentInput(args);
      const provider = runtime.repositoryContext ?? new FixedFileRepositoryContextManifestProvider();
      return agentResult("repository-context", await provider.load());
    }
    if (Object.hasOwn(args.flags, "repository-asana")) {
      readRepositoryAsanaAgentInput(args);
      const context = await readCurrentGitContext();
      const provider = runtime.repositoryAsanaMapping ?? new FixedFileRepositoryAsanaMappingProvider();
      const mapping = await provider.find({
        remote: context.remote,
        repository: context.repository,
      });
      if (!mapping) {
        throw new CliError(
          "not-found",
          "No trusted repository-to-Asana mapping is configured for this repository",
        );
      }
      return agentResult("repository-asana", {
        git: {
          remote: context.remote,
          repository: context.repository,
        },
        mapping: {
          workspace_gid: mapping.workspace_gid,
          ...(mapping.project_gid === undefined ? {} : { project_gid: mapping.project_gid }),
          ...(mapping.git_reference_custom_field_gid === undefined
            ? {}
            : { git_reference_custom_field_gid: mapping.git_reference_custom_field_gid }),
        },
      });
    }
    readGitCurrentAgentInput(args);
    return agentResult("git-current", await readCurrentGitContext());
  }
  const input = readOperationStatusAgentInput(args);
  const record = await runtime.operations.inspect(input.operation_id);
  if (!record) {
    throw new CliError("not-found", "Operation does not exist", undefined, {
      operation_id: input.operation_id,
    });
  }
  return agentResult("operation-status", operationStatusProjection(record));
}


export interface LocalAgentCommandRuntime {
  operations: OperationRepository;
  repositoryAsanaMapping?: RepositoryAsanaMappingProvider;
  repositoryContext?: RepositoryContextManifestProvider;
}

export interface AgentCommandRuntime {
  operations: OperationRepository;
  writePolicy?: HostScopedWritePolicyProvider;
  audit?: MetadataAuditStore;
  repositoryContext?: RepositoryContextManifestProvider;
}
