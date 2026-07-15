import {
  booleanFlag,
  flag,
  flagStrings,
  integerFlag,
  parseArgs,
  requirePositional,
  stringFlag,
  type ParsedArgs,
} from "./args";
import { z } from "zod";
import {
  addTaskComment,
  getMe,
  getMyTasks,
  getTask,
  getTaskComments,
  getWorkspaces,
  searchTasks,
  STORY_FIELDS,
  TASK_FIELDS,
  updateTask,
} from "./asana-commands";
import { CliError, errorStatus } from "./errors";
import { AUTH_HELP, HELP, PAT_HELP } from "./help";
import { materializeFileReferences, readJsonInput, readTextInput } from "./io";
import { rawRequest } from "./raw-request";
import {
  apiClassNames,
  apiMethodNames,
  asCollection,
  collectPages,
  createClient,
  invokeApiMethod,
  isCollection,
  normalizeSdkResult,
  resolveApiClass,
  type AsanaClient,
} from "./sdk";
import {
  deleteStoredPat,
  readPatInteractively,
  patFromStdin,
  resolvePatWithSource,
  savePat,
  storedPat,
} from "./pat-store";
import { AGENT_MANIFEST, enforceAgentPolicy, isAgentMode } from "./agent-mode";
import { rejectDeprecatedLegacyAgentApply } from "./agent-deprecations";
import { runAgentCommand, runLocalAgentCommand } from "./agent-cli";
import { FileMetadataAuditStore } from "./audit/file-repository";
import { FixedFileHostScopedWritePolicyProvider } from "./host-write-policy";
import { FileOperationRepository } from "./operations/file-repository";
import type { OperationRepository } from "./operations/repository";
import {
  jsonArraySchema,
  jsonObjectSchema,
  jsonValueSchema,
  parseExternalData,
  taskListEnvelopeSchema,
  userSchema,
  zodIssueSummary,
  type AsanaTask,
} from "./schemas";
import { publishAgentSchemas } from "./agent-contract";
import { runIntegrationCommand } from "./integration-cli";
import { CLI_VERSION } from "./version";

const completedModeSchema = z.enum(["false", "true", "all"]);
const cliEnvironmentSchema = z.object({
  ASANA_ACCESS_TOKEN: z.string().optional(),
  ASANA_PAT: z.string().optional(),
  ASANA_GIT_FIELD_GID: z.string().optional(),
});

function lazyFileOperationRepository(): OperationRepository {
  let fileRepository: FileOperationRepository | undefined;
  const file = (): FileOperationRepository => {
    fileRepository ??= new FileOperationRepository();
    return fileRepository;
  };
  return {
    create: (input) => file().create(input),
    get: (id) => file().get(id),
    inspect: (id) => file().inspect(id),
    compareAndSet: (transition) => file().compareAndSet(transition),
  };
}

export interface CliResult {
  value?: unknown;
  text?: string;
  compact?: boolean;
  agentMode?: boolean;
}

function pageOptions(args: ParsedArgs) {
  return {
    all: booleanFlag(args, "all", false) || booleanFlag(args, "paginate", false),
    maxResults: integerFlag(args, "max-results", isAgentMode(args) ? 100 : 1000, 1, 100_000),
  };
}

function fields(args: ParsedArgs, defaults: string): string {
  return stringFlag(args, "fields") ?? defaults;
}

function taskGid(value: string): string {
  if (!value.startsWith("http://") && !value.startsWith("https://")) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError("validation", `Invalid task URL: ${value}`);
  }
  if (url.hostname !== "app.asana.com" && !url.hostname.endsWith(".asana.com")) {
    throw new CliError("validation", "Task URL must point to asana.com");
  }
  const gids = url.pathname.match(/\d+/g);
  if (!gids?.length) throw new CliError("validation", `No task GID found in URL: ${value}`);
  return gids[gids.length - 1]!;
}

function completedMode(args: ParsedArgs): "false" | "true" | "all" {
  if (booleanFlag(args, "include-completed", false)) return "all";
  const value = flag(args, "completed");
  if (value === undefined || value === false) return "false";
  if (value === true) return "true";
  const normalized = value.toLowerCase();
  const parsed = completedModeSchema.safeParse(normalized);
  if (parsed.success) return parsed.data;
  throw new CliError("validation", "--completed must be false, true, or all");
}

function nullable(value: string): string | null {
  return value.toLowerCase() === "null" ? null : value;
}

async function updateData(args: ParsedArgs): Promise<Record<string, unknown>> {
  const json = stringFlag(args, "data") ?? stringFlag(args, "input");
  let data: Record<string, unknown> = {};
  if (json !== undefined) {
    const parsed = await readJsonInput(json, "--data", jsonObjectSchema);
    if ("data" in parsed) {
      const nested = jsonObjectSchema.safeParse(parsed.data);
      if (!nested.success) throw new CliError("validation", "--data.data must be a JSON object");
      data = nested.data;
    } else {
      data = parsed;
    }
  }

  const stringFields: Array<[string, string]> = [
    ["name", "name"],
    ["notes", "notes"],
    ["html-notes", "html_notes"],
    ["assignee", "assignee"],
    ["due-on", "due_on"],
    ["due-at", "due_at"],
    ["start-on", "start_on"],
  ];
  for (const [option, property] of stringFields) {
    const value = stringFlag(args, option);
    if (value !== undefined) data[property] = nullable(value);
  }
  if (flag(args, "completed") !== undefined) data.completed = booleanFlag(args, "completed");
  if (booleanFlag(args, "not-completed", false)) data.completed = false;
  if (booleanFlag(args, "unassign", false)) data.assignee = null;
  if (booleanFlag(args, "clear-due", false)) {
    data.due_on = null;
    data.due_at = null;
  }
  const notesFile = stringFlag(args, "notes-file");
  if (notesFile) data.notes = await readTextInput(`@${notesFile}`, "--notes-file");
  if (data.due_on != null && data.due_at != null) {
    throw new CliError("validation", "due_on and due_at cannot be set at the same time");
  }
  return data;
}

function extractTasks(result: unknown): AsanaTask[] {
  const parsed = taskListEnvelopeSchema.safeParse(result);
  if (!parsed.success) {
    throw new CliError("internal", `Invalid task list response: ${zodIssueSummary(parsed.error)}`);
  }
  return parsed.data.data;
}

function deduplicateTasks(tasks: AsanaTask[]): AsanaTask[] {
  const seen = new Set<string>();
  return tasks.filter((task) => {
    const key = String(task?.gid ?? JSON.stringify(task));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function taskSearchText(task: AsanaTask): string {
  const customFields = Array.isArray(task?.custom_fields)
    ? task.custom_fields.map((field) => field.display_value ?? field.text_value ?? "")
    : [];
  return [task?.name, task?.notes, task?.html_notes, ...customFields]
    .filter((value) => typeof value === "string")
    .join("\n");
}

function matchesGitReference(task: AsanaTask, reference: string, contains: boolean): boolean {
  const haystack = taskSearchText(task);
  if (contains) return haystack.toLowerCase().includes(reference.toLowerCase());
  const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}($|[^A-Za-z0-9])`, "i").test(haystack);
}

async function findGitTasks(client: AsanaClient, args: ParsedArgs, reference: string): Promise<unknown> {
  const page = pageOptions(args);
  const workspace = stringFlag(args, "workspace");
  const selectedFields = fields(args, TASK_FIELDS);
  const mine = !booleanFlag(args, "all-assignees", false);
  const contains = booleanFlag(args, "contains", false);
  const environment = cliEnvironmentSchema.parse(process.env);
  const configuredFields = [
    ...flagStrings(args, "field"),
    ...(environment.ASANA_GIT_FIELD_GID ?? "").split(",").filter(Boolean),
  ];

  try {
    const results = [
      await searchTasks(client, reference, {
        ...page,
        workspace,
        fields: selectedFields,
        mine,
      }),
    ];
    for (const fieldGid of configuredFields) {
      const operator = contains ? "contains" : "value";
      results.push(await searchTasks(client, reference, {
        ...page,
        workspace,
        fields: selectedFields,
        mine,
        includeText: false,
        extra: { [`custom_fields.${fieldGid}.${operator}`]: reference },
      }));
    }
    const merged = deduplicateTasks(results.flatMap(extractTasks));
    const exact = merged.filter((task) => matchesGitReference(task, reference, contains));
    return {
      data: exact,
      meta: {
        query: reference,
        count: exact.length,
        mode: "asana-search",
        exact_match: !contains,
        custom_fields: configuredFields,
        warnings: [
          "Asana full-text search covers task names and descriptions, not comments.",
          "Search indexing can lag behind recent task updates.",
        ],
      },
    };
  } catch (error) {
    if (errorStatus(error) !== 402 || booleanFlag(args, "no-scan-fallback", false)) throw error;
    const scanned = await getMyTasks(client, {
      ...page,
      all: true,
      workspace,
      completed: "all",
      limit: integerFlag(args, "limit", 100, 1, 100),
      fields: selectedFields,
    });
    const matches = deduplicateTasks(extractTasks(scanned)).filter((task) =>
      matchesGitReference(task, reference, contains),
    );
    return {
      data: matches,
      meta: {
        query: reference,
        count: matches.length,
        mode: "local-scan-fallback",
        reason: "Asana advanced search returned HTTP 402 (Premium feature)",
        exact_match: !contains,
        scanned: extractTasks(scanned).length,
      },
    };
  }
}

async function apiCommand(client: AsanaClient | undefined, args: ParsedArgs): Promise<CliResult> {
  const action = requirePositional(args, 1, "api action (list, docs, or call)");
  if (action === "list" || action === "methods") {
    const className = args.positionals[2];
    if (!className) return { value: { classes: apiClassNames() } };
    const resolved = resolveApiClass(className);
    return { value: { class: resolved.name, methods: apiMethodNames(resolved.name) } };
  }
  if (action === "docs") {
    const className = requirePositional(args, 2, "API class");
    const method = args.positionals[3];
    const resolved = resolveApiClass(className);
    if (method && !apiMethodNames(resolved.name).includes(method)) {
      throw new CliError("usage", `Unknown method ${resolved.name}.${method}`);
    }
    const anchor = method ? `#${method}` : "";
    return {
      value: {
        class: resolved.name,
        ...(method ? { method } : {}),
        url: `https://github.com/Asana/node-asana/blob/master/docs/${resolved.name}.md${anchor}`,
      },
    };
  }
  if (action !== "call") throw new CliError("usage", `Unknown api action: ${action}`);
  if (!client) {
    throw new CliError("internal", "Internal error: authenticated client not initialized");
  }

  const className = requirePositional(args, 2, "API class");
  const method = requirePositional(args, 3, "API method");
  const rawArgs = stringFlag(args, "args") ?? "[]";
  const callArgs = await readJsonInput(rawArgs, "--args", jsonArraySchema);
  const materialized = materializeFileReferences(callArgs);
  if (!Array.isArray(materialized)) throw new CliError("validation", "--args must be a JSON array");
  const result = await invokeApiMethod(
    client,
    className,
    method,
    materialized,
  );
  if (isCollection(result) && pageOptions(args).all) {
    return {
      value: await collectPages(
        asCollection(result, `${className}.${method}`),
        true,
        pageOptions(args).maxResults,
        z.unknown(),
        `${className}.${method}`,
      ),
    };
  }
  return { value: normalizeSdkResult(result) };
}

async function patCommand(args: ParsedArgs): Promise<CliResult> {
  const action = args.positionals[2] ?? "help";
  const compact = booleanFlag(args, "compact", false);
  if (action === "help") return { text: PAT_HELP };
  if (action === "set") {
    if (args.positionals[3] !== undefined) {
      throw new CliError(
        "policy-denied",
        "Never pass a PAT as a command-line argument; use the hidden prompt or --stdin",
      );
    }
    const fromEnv = booleanFlag(args, "from-env", false);
    if (fromEnv && booleanFlag(args, "stdin", false)) {
      throw new CliError("usage", "Use only one of --from-env and --stdin");
    }
    let pat: string;
    if (fromEnv) {
      const environment = cliEnvironmentSchema.parse(process.env);
      pat = environment.ASANA_ACCESS_TOKEN || environment.ASANA_PAT || "";
      if (!pat) {
        throw new CliError(
          "auth-required",
          "--from-env requires ASANA_PAT or ASANA_ACCESS_TOKEN",
        );
      }
    } else if (booleanFlag(args, "stdin", false)) {
      pat = patFromStdin(await Bun.stdin.text());
    } else {
      pat = await readPatInteractively();
    }

    let user: unknown;
    if (!booleanFlag(args, "no-verify", false)) {
      const me = await getMe(createClient(pat));
      user = parseExternalData(me, userSchema, "UsersApi.getUser");
    }
    await savePat(pat);
    return {
      value: {
        stored: true,
        storage: "os-credential-store",
        verified: !booleanFlag(args, "no-verify", false),
        ...(user ? { user } : {}),
        note: "ASANA_PAT and ASANA_ACCESS_TOKEN override the stored PAT when set.",
      },
      compact,
    };
  }
  if (action === "status") {
    const local = await storedPat();
    const resolved = await resolvePatWithSource();
    delete process.env.ASANA_ACCESS_TOKEN;
    delete process.env.ASANA_PAT;
    const me = await getMe(createClient(resolved.pat));
    return {
      value: {
        configured: true,
        valid: true,
        source: resolved.source,
        os_credential_stored: Boolean(local),
        user: parseExternalData(me, userSchema, "UsersApi.getUser"),
      },
      compact,
    };
  }
  if (action === "delete" || action === "remove") {
    const deleted = await deleteStoredPat();
    return {
      value: {
        deleted,
        storage: "os-credential-store",
        environment_override_active: Boolean(
          process.env.ASANA_PAT?.trim() || process.env.ASANA_ACCESS_TOKEN?.trim(),
        ),
        note: "This does not revoke the PAT in Asana. Revoke it in Asana Developer Console if needed.",
      },
      compact,
    };
  }
  throw new CliError("usage", `Unknown auth pat action: ${action}`);
}

export async function runCli(argv: string[]): Promise<CliResult> {
  const args = parseArgs(argv);
  const command = args.positionals[0];
  for (const forbidden of ["token", "pat", "password", "access-token"]) {
    if (Object.hasOwn(args.flags, forbidden)) {
      throw new CliError(
        "policy-denied",
        `--${forbidden} is forbidden; credentials are accepted only from the OS store or environment`,
      );
    }
  }
  if (command === "agent") rejectDeprecatedLegacyAgentApply(args.positionals[1]);
  enforceAgentPolicy(args);
  const compact = booleanFlag(args, "compact", false);
  if (flag(args, "version") === true || command === "version") return { text: CLI_VERSION };
  if (!command || flag(args, "help") === true || command === "help") return { text: HELP };
  if (command === "integrations") {
    const result = await runIntegrationCommand(args);
    return { ...result, compact };
  }
  if (command === "agent" && args.positionals[1] === "schema") {
    return {
      value: publishAgentSchemas(args.positionals[2]),
      compact,
      agentMode: true,
    };
  }
  if (
    command === "agent" &&
    (args.positionals[1] === undefined || ["manifest", "capabilities"].includes(args.positionals[1]))
  ) {
    return { value: AGENT_MANIFEST, compact, agentMode: true };
  }
  if (command === "agent" && args.positionals[1] === "operation") {
    return {
      value: await runLocalAgentCommand(args, { operations: lazyFileOperationRepository() }),
      compact: true,
      agentMode: true,
    };
  }
  if (command === "auth" && (args.positionals[1] === undefined || args.positionals[1] === "help")) {
    return { text: AUTH_HELP };
  }
  if (command === "auth" && args.positionals[1] === "pat") {
    return patCommand(args);
  }
  if (command === "api" && ["list", "methods", "docs"].includes(args.positionals[1] ?? "")) {
    return { ...(await apiCommand(undefined, args)), compact };
  }

  const resolvedPat = await resolvePatWithSource();
  const pat = resolvedPat.pat;
  delete process.env.ASANA_ACCESS_TOKEN;
  delete process.env.ASANA_PAT;
  const client = createClient(pat);

  if (command === "auth" && args.positionals[1] === "status") {
    const me = await getMe(client);
    return {
      value: {
        authenticated: true,
        source: resolvedPat.source,
        user: parseExternalData(me, userSchema, "UsersApi.getUser"),
      },
      compact,
    };
  }
  if (command === "agent") {
    return {
      value: await runAgentCommand(client, args, {
        operations: lazyFileOperationRepository(),
        writePolicy: new FixedFileHostScopedWritePolicyProvider(),
        audit: new FileMetadataAuditStore(),
      }),
      compact: true,
      agentMode: true,
    };
  }
  if (command === "me") return { value: await getMe(client), compact };
  if (command === "workspaces" || (command === "workspace" && args.positionals[1] === "list")) {
    return { value: await getWorkspaces(client, pageOptions(args)), compact };
  }
  if (command === "api") return { ...(await apiCommand(client, args)), compact };

  if (command === "request") {
    const method = requirePositional(args, 1, "HTTP method");
    const path = requirePositional(args, 2, "API path");
    const queryInput = stringFlag(args, "query");
    const dataInput = stringFlag(args, "data") ?? stringFlag(args, "body");
    const query = queryInput
      ? await readJsonInput(queryInput, "--query", jsonObjectSchema)
      : undefined;
    const data = dataInput ? await readJsonInput(dataInput, "--data", jsonValueSchema) : undefined;
    return { value: await rawRequest(pat, { method, path, query, data }), compact };
  }

  if (command === "tasks" && args.positionals[1] === "mine" || command === "task" && args.positionals[1] === "mine") {
    return {
      value: await getMyTasks(client, {
        ...pageOptions(args),
        workspace: stringFlag(args, "workspace"),
        completed: completedMode(args),
        limit: integerFlag(args, "limit", 50, 1, 100),
        fields: fields(args, TASK_FIELDS),
        modifiedSince: stringFlag(args, "modified-since"),
      }),
      compact,
    };
  }

  if (command === "task") {
    const action = requirePositional(args, 1, "task action");
    if (action === "get") {
      return {
        value: await getTask(client, taskGid(requirePositional(args, 2, "task GID")), fields(args, TASK_FIELDS)),
        compact,
      };
    }
    if (action === "comments" || action === "stories") {
      return {
        value: await getTaskComments(client, taskGid(requirePositional(args, 2, "task GID")), {
          ...pageOptions(args),
          limit: integerFlag(args, "limit", 100, 1, 100),
          fields: fields(args, STORY_FIELDS),
          allStories: action === "stories" || booleanFlag(args, "all-stories", false),
        }),
        compact,
      };
    }
    if (action === "update") {
      const gid = taskGid(requirePositional(args, 2, "task GID"));
      const data = await updateData(args);
      if (booleanFlag(args, "dry-run", false)) {
        return { value: { dry_run: true, operation: "TasksApi.updateTask", task_gid: gid, body: { data } }, compact };
      }
      return { value: await updateTask(client, gid, data, fields(args, TASK_FIELDS)), compact };
    }
    if (action === "comment") {
      const gid = taskGid(requirePositional(args, 2, "task GID"));
      const html = stringFlag(args, "html-text");
      let text = stringFlag(args, "text");
      const file = stringFlag(args, "file");
      if (file) text = await readTextInput(`@${file}`, "--file");
      if (booleanFlag(args, "stdin", false)) text = await readTextInput("-", "--stdin");
      if (!text && !html) text = args.positionals.slice(3).join(" ");
      if (text && html) {
        throw new CliError("validation", "Use either text or html_text for a comment, not both");
      }
      const content = html ? { html_text: html } : { text: text ?? "" };
      if (booleanFlag(args, "dry-run", false)) {
        return { value: { dry_run: true, operation: "StoriesApi.createStoryForTask", task_gid: gid, body: { data: content } }, compact };
      }
      return { value: await addTaskComment(client, gid, content, fields(args, STORY_FIELDS)), compact };
    }
    if (action === "search" || action === "search-git" || action === "find-git") {
      const query = args.positionals.slice(2).join(" ");
      if (!query) throw new CliError("usage", "Missing search query");
      if (action !== "search") return { value: await findGitTasks(client, args, query), compact };
      const filtersInput = stringFlag(args, "filters");
      const extra = filtersInput
        ? await readJsonInput(filtersInput, "--filters", jsonObjectSchema)
        : undefined;
      const completed = flag(args, "completed") === undefined
        ? undefined
        : booleanFlag(args, "completed");
      return {
        value: await searchTasks(client, query, {
          ...pageOptions(args),
          workspace: stringFlag(args, "workspace"),
          fields: fields(args, TASK_FIELDS),
          mine: !booleanFlag(args, "all-assignees", false),
          completed,
          extra,
        }),
        compact,
      };
    }
    if (action === "get-custom-id") {
      const customId = requirePositional(args, 2, "custom task ID");
      const workspace = stringFlag(args, "workspace");
      if (!workspace) {
        throw new CliError("usage", "task get-custom-id requires --workspace <gid>");
      }
      return {
        value: await invokeApiMethod(client, "TasksApi", "getTaskForCustomID", [
          workspace,
          customId,
          { opt_fields: fields(args, TASK_FIELDS) },
        ]),
        compact,
      };
    }
    throw new CliError("usage", `Unknown task action: ${action}`);
  }

  throw new CliError("usage", `Unknown command: ${command}. Run \`asana-cli --help\`.`);
}
