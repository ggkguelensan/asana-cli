import {
  parseAgentActionInput,
  readAgentActionInput,
  type AgentActionInput,
  type AgentActionName,
} from "./agent-contract";
import { booleanFlag, type FlagValue, type ParsedArgs } from "./args";
import { CliError } from "./errors";

export type DirectReadAction =
  | "status"
  | "my-tasks"
  | "get-task"
  | "list-comments"
  | "search-tasks"
  | "find-git";

const directFlags = {
  status: [],
  "my-tasks": ["workspace", "completed", "limit", "paginate", "max-results"],
  "get-task": ["task", "include", "max-content-bytes"],
  "list-comments": ["task", "limit", "paginate", "max-results", "max-content-bytes"],
  "search-tasks": ["query", "workspace", "all-assignees", "completed", "max-results"],
  "find-git": [
    "query",
    "workspace",
    "all-assignees",
    "completed",
    "max-results",
    "field",
    "contains",
  ],
} as const satisfies Record<DirectReadAction, readonly string[]>;

function assertPositionalShape(args: ParsedArgs, action: string): void {
  if (args.positionals.length !== 2) {
    throw new CliError("usage", `agent ${action} does not accept positional arguments`);
  }
}

function scalarFlag(args: ParsedArgs, name: string): FlagValue | undefined {
  const value = args.flags[name];
  if (Array.isArray(value)) {
    throw new CliError("usage", `--${name} may be specified only once`);
  }
  return value;
}

function stringValue(args: ParsedArgs, name: string): string | undefined {
  const value = scalarFlag(args, name);
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new CliError("usage", `--${name} requires a value`);
  }
  return value;
}

function integerValue(args: ParsedArgs, name: string): number | undefined {
  const value = stringValue(args, name);
  return value === undefined ? undefined : value.trim() ? Number(value) : Number.NaN;
}

function booleanValue(args: ParsedArgs, name: string): boolean | undefined {
  if (scalarFlag(args, name) === undefined) return undefined;
  return booleanFlag(args, name);
}

function includeValues(args: ParsedArgs): string[] | undefined {
  const value = args.flags.include;
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  if (values.some((entry) => typeof entry !== "string")) {
    throw new CliError("usage", "--include requires a value");
  }
  return values.map(String);
}

function assignIfDefined(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value !== undefined) target[key] = value;
}

function assertKnownFlags(
  args: ParsedArgs,
  action: DirectReadAction,
): { input: string | undefined } {
  const allowed = new Set<string>(["input", ...directFlags[action]]);
  for (const name of Object.keys(args.flags)) {
    if (!allowed.has(name)) {
      throw new CliError("usage", `Unknown option for agent ${action}: --${name}`);
    }
  }

  const input = stringValue(args, "input");
  if (input !== undefined) {
    if (input !== "-") {
      throw new CliError("usage", "Agent --input must be the stdin marker: --input -");
    }
    const conflicting = Object.keys(args.flags).filter((name) => name !== "input");
    if (conflicting.length > 0) {
      throw new CliError(
        "usage",
        `--input cannot be combined with direct action flags: --${conflicting[0]}`,
      );
    }
  }
  return { input };
}

function requireValue(value: string | undefined, name: string): string {
  if (value === undefined) throw new CliError("usage", `Missing required --${name}`);
  return value;
}

export async function readDirectAgentInput<Action extends DirectReadAction>(
  args: ParsedArgs,
  action: Action,
): Promise<AgentActionInput<Action>> {
  assertPositionalShape(args, action);
  const { input } = assertKnownFlags(args, action);
  if (input !== undefined) return readAgentActionInput(input, action);

  if (action === "status") return parseAgentActionInput({}, action);

  const raw: Record<string, unknown> = {};
  if (action === "my-tasks") {
    assignIfDefined(raw, "workspace_gid", stringValue(args, "workspace"));
    assignIfDefined(raw, "completed", stringValue(args, "completed"));
    assignIfDefined(raw, "limit", integerValue(args, "limit"));
    assignIfDefined(raw, "paginate", booleanValue(args, "paginate"));
    assignIfDefined(raw, "max_results", integerValue(args, "max-results"));
  } else if (action === "get-task") {
    raw.task_gid = requireValue(stringValue(args, "task"), "task");
    raw.include = includeValues(args) ?? [];
    assignIfDefined(raw, "max_content_bytes", integerValue(args, "max-content-bytes"));
  } else if (action === "list-comments") {
    raw.task_gid = requireValue(stringValue(args, "task"), "task");
    assignIfDefined(raw, "limit", integerValue(args, "limit"));
    assignIfDefined(raw, "paginate", booleanValue(args, "paginate"));
    assignIfDefined(raw, "max_results", integerValue(args, "max-results"));
    assignIfDefined(raw, "max_content_bytes", integerValue(args, "max-content-bytes"));
  } else {
    raw.query = requireValue(stringValue(args, "query"), "query");
    assignIfDefined(raw, "workspace_gid", stringValue(args, "workspace"));
    assignIfDefined(raw, "all_assignees", booleanValue(args, "all-assignees"));
    assignIfDefined(raw, "completed", booleanValue(args, "completed"));
    assignIfDefined(raw, "max_results", integerValue(args, "max-results"));
    if (action === "find-git") {
      assignIfDefined(raw, "field_gid", stringValue(args, "field"));
      assignIfDefined(raw, "contains", booleanValue(args, "contains"));
    }
  }
  return parseAgentActionInput(raw, action);
}

export function readOperationStatusAgentInput(
  args: ParsedArgs,
): AgentActionInput<"operation-status"> {
  if (args.positionals.length !== 4 || args.positionals[1] !== "operation") {
    throw new CliError("usage", "Usage: asana-cli agent operation status UUID");
  }
  if (args.positionals[2] !== "status") {
    throw new CliError("usage", "Usage: asana-cli agent operation status UUID");
  }
  if (Object.keys(args.flags).length > 0) {
    throw new CliError("usage", "agent operation status does not accept options");
  }
  return parseAgentActionInput({ operation_id: args.positionals[3] }, "operation-status");
}

async function readDirectOrStdinInput<Action extends "apply" | "prepare-comment">(
  args: ParsedArgs,
  action: Action,
  directFlagNames: readonly string[],
  directValue: () => Record<string, unknown>,
): Promise<AgentActionInput<Action>> {
  assertPositionalShape(args, action);
  const allowed = new Set(["input", ...directFlagNames]);
  for (const name of Object.keys(args.flags)) {
    if (!allowed.has(name)) {
      throw new CliError("usage", `Unknown option for agent ${action}: --${name}`);
    }
  }
  const input = stringValue(args, "input");
  if (input !== undefined) {
    if (input !== "-") {
      throw new CliError("usage", "Agent --input must be the stdin marker: --input -");
    }
    const conflicting = Object.keys(args.flags).filter((name) => name !== "input");
    if (conflicting.length > 0) {
      throw new CliError(
        "usage",
        `--input cannot be combined with direct action flags: --${conflicting[0]}`,
      );
    }
    return readAgentActionInput(input, action);
  }
  return parseAgentActionInput(directValue(), action);
}

export function readApplyAgentInput(
  args: ParsedArgs,
): Promise<AgentActionInput<"apply">> {
  return readDirectOrStdinInput(args, "apply", ["operation-id"], () => ({
    operation_id: requireValue(stringValue(args, "operation-id"), "operation-id"),
  }));
}

export function readPrepareCommentAgentInput(
  args: ParsedArgs,
): Promise<AgentActionInput<"prepare-comment">> {
  return readDirectOrStdinInput(args, "prepare-comment", ["task", "text"], () => ({
    task_gid: requireValue(stringValue(args, "task"), "task"),
    text: requireValue(stringValue(args, "text"), "text"),
  }));
}

export async function readStdinAgentInput<Action extends AgentActionName>(
  args: ParsedArgs,
  action: Action,
): Promise<AgentActionInput<Action>> {
  assertPositionalShape(args, action);
  for (const name of Object.keys(args.flags)) {
    if (name !== "input") {
      throw new CliError("usage", `Unknown option for agent ${action}: --${name}`);
    }
  }
  const input = stringValue(args, "input");
  if (input !== "-") {
    throw new CliError("usage", `agent ${action} requires JSON on stdin via --input -`);
  }
  return readAgentActionInput(input, action);
}
