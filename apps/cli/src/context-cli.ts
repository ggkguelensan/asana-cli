import { integerFlag, stringFlag, type ParsedArgs } from "./args";
import {
  FileContextStateStore,
  type ContextStateStore,
} from "./context-state";
import { CliError } from "./errors";
import {
  readCurrentGitStorageIdentity,
  type GitStorageIdentity,
} from "./git-context";
import { qualifiedTaskAliasSchema } from "./repository-context";
import { gidSchema } from "./schemas";

export type ContextCommandRuntime = Readonly<{
  store: ContextStateStore;
  identity: () => Promise<GitStorageIdentity>;
}>;

function requireExactPositionals(
  args: ParsedArgs,
  expected: number,
  usage: string,
): void {
  if (args.positionals.length !== expected) {
    throw new CliError("usage", `Usage: ${usage}`);
  }
}

function requireAllowedFlags(args: ParsedArgs, allowed: readonly string[]): void {
  for (const [name, value] of Object.entries(args.flags)) {
    if (!allowed.includes(name)) {
      throw new CliError("usage", `Unsupported option for context command: --${name}`);
    }
    if (Array.isArray(value)) {
      throw new CliError("usage", `--${name} may be provided only once`);
    }
  }
}

function requiredStringFlag(args: ParsedArgs, name: string): string {
  const value = stringFlag(args, name);
  if (value === undefined) throw new CliError("usage", `--${name} is required`);
  return value;
}

function requiredRevision(args: ParsedArgs): number {
  if (!Object.hasOwn(args.flags, "revision")) {
    throw new CliError("usage", "--revision is required for explicit compare-and-set");
  }
  return integerFlag(args, "revision", 0, 0, 2_147_483_647);
}

function validatedQualifiedAlias(value: string): string {
  const parsed = qualifiedTaskAliasSchema.safeParse(value);
  if (!parsed.success) {
    throw new CliError(
      "validation",
      "QUALIFIED_ALIAS must use canonical task:<project>/<locator>--<title> syntax",
    );
  }
  return parsed.data;
}

function taskGid(value: string, option: "--task" | "--expected-task"): string {
  const parsed = gidSchema.safeParse(value);
  if (!parsed.success) {
    throw new CliError("validation", `${option} must be a numeric Asana GID`);
  }
  return parsed.data;
}

function defaultRuntime(): ContextCommandRuntime {
  try {
    return {
      store: new FileContextStateStore(),
      identity: readCurrentGitStorageIdentity,
    };
  } catch (error: unknown) {
    if (error instanceof CliError) throw error;
    throw new CliError("storage-invalid", "Local context state is unavailable or unsafe");
  }
}

/**
 * Human-only local context lifecycle. runCli enforces agent policy before this
 * router is reached, and this module never resolves credentials or creates an
 * Asana client.
 */
export async function runContextCommand(
  args: ParsedArgs,
  runtime?: ContextCommandRuntime,
): Promise<unknown> {
  const action = args.positionals[1];

  if (action === "alias") {
    const aliasAction = args.positionals[2];
    if (aliasAction === "list") {
      requireExactPositionals(args, 3, "asana-cli context alias list");
      requireAllowedFlags(args, ["compact"]);
      const activeRuntime = runtime ?? defaultRuntime();
      const identity = await activeRuntime.identity();
      return {
        schema: "asana-cli.context-alias-list.v1",
        ...await activeRuntime.store.listAliases(identity),
      };
    }

    const qualifiedAlias = args.positionals[3];
    if (!qualifiedAlias || !["set", "replace", "remove"].includes(aliasAction ?? "")) {
      throw new CliError(
        "usage",
        "Usage: asana-cli context alias list|set|replace|remove",
      );
    }
    requireExactPositionals(
      args,
      4,
      `asana-cli context alias ${aliasAction} QUALIFIED_ALIAS`,
    );

    if (aliasAction === "set") {
      requireAllowedFlags(args, ["task", "compact"]);
      const parsedAlias = validatedQualifiedAlias(qualifiedAlias);
      const parsedTaskGid = taskGid(requiredStringFlag(args, "task"), "--task");
      const activeRuntime = runtime ?? defaultRuntime();
      const identity = await activeRuntime.identity();
      return {
        schema: "asana-cli.context-alias-list.v1",
        ...await activeRuntime.store.setAlias(
          identity,
          parsedAlias,
          parsedTaskGid,
        ),
      };
    }

    if (aliasAction === "replace") {
      requireAllowedFlags(args, ["task", "expected-task", "revision", "compact"]);
      const parsedAlias = validatedQualifiedAlias(qualifiedAlias);
      const parsedTaskGid = taskGid(requiredStringFlag(args, "task"), "--task");
      const expectedTaskGid = taskGid(
        requiredStringFlag(args, "expected-task"),
        "--expected-task",
      );
      const expectedRevision = requiredRevision(args);
      const activeRuntime = runtime ?? defaultRuntime();
      const identity = await activeRuntime.identity();
      return {
        schema: "asana-cli.context-alias-list.v1",
        ...await activeRuntime.store.replaceAlias(identity, {
          qualified_alias: parsedAlias,
          task_gid: parsedTaskGid,
          expected_task_gid: expectedTaskGid,
          expected_revision: expectedRevision,
        }),
      };
    }

    requireAllowedFlags(args, ["expected-task", "revision", "compact"]);
    const parsedAlias = validatedQualifiedAlias(qualifiedAlias);
    const expectedTaskGid = taskGid(
      requiredStringFlag(args, "expected-task"),
      "--expected-task",
    );
    const expectedRevision = requiredRevision(args);
    const activeRuntime = runtime ?? defaultRuntime();
    const identity = await activeRuntime.identity();
    return {
      schema: "asana-cli.context-alias-list.v1",
      ...await activeRuntime.store.removeAlias(identity, {
        qualified_alias: parsedAlias,
        expected_task_gid: expectedTaskGid,
        expected_revision: expectedRevision,
      }),
    };
  }

  if (action === "activate") {
    requireExactPositionals(args, 3, "asana-cli context activate QUALIFIED_ALIAS");
    requireAllowedFlags(args, ["compact"]);
    const parsedAlias = validatedQualifiedAlias(args.positionals[2] ?? "");
    const activeRuntime = runtime ?? defaultRuntime();
    const identity = await activeRuntime.identity();
    return {
      schema: "asana-cli.quick-context.v1",
      ...await activeRuntime.store.activate(identity, parsedAlias),
    };
  }

  if (action === "bind") {
    requireExactPositionals(
      args,
      3,
      "asana-cli context bind QUALIFIED_ALIAS --task GID",
    );
    requireAllowedFlags(args, ["task", "compact"]);
    const parsedAlias = validatedQualifiedAlias(args.positionals[2] ?? "");
    const parsedTaskGid = taskGid(requiredStringFlag(args, "task"), "--task");
    const activeRuntime = runtime ?? defaultRuntime();
    const identity = await activeRuntime.identity();
    const ensured = await activeRuntime.store.ensureAlias(
      identity,
      parsedAlias,
      parsedTaskGid,
    );
    const active = await activeRuntime.store.activate(identity, parsedAlias);
    return {
      schema: "asana-cli.worktree-bind.v1",
      alias_created: ensured.created,
      ...active,
    };
  }

  if (action === "deactivate") {
    requireExactPositionals(
      args,
      3,
      "asana-cli context deactivate QUALIFIED_ALIAS",
    );
    requireAllowedFlags(args, ["compact"]);
    const parsedAlias = validatedQualifiedAlias(args.positionals[2] ?? "");
    const activeRuntime = runtime ?? defaultRuntime();
    const identity = await activeRuntime.identity();
    return {
      schema: "asana-cli.worktree-deactivate.v1",
      ...await activeRuntime.store.deactivate(identity, parsedAlias),
    };
  }

  if (action === "quick") {
    requireExactPositionals(args, 2, "asana-cli context quick");
    requireAllowedFlags(args, ["compact"]);
    const activeRuntime = runtime ?? defaultRuntime();
    const identity = await activeRuntime.identity();
    return {
      schema: "asana-cli.quick-context.v1",
      ...await activeRuntime.store.quick(identity),
    };
  }

  if (action === "history") {
    requireExactPositionals(args, 2, "asana-cli context history");
    requireAllowedFlags(args, ["compact"]);
    const activeRuntime = runtime ?? defaultRuntime();
    const identity = await activeRuntime.identity();
    return {
      schema: "asana-cli.context-history.v1",
      ...await activeRuntime.store.history(identity),
    };
  }

  if (action === "clear") {
    requireExactPositionals(args, 2, "asana-cli context clear --revision N");
    requireAllowedFlags(args, ["revision", "compact"]);
    const revision = requiredRevision(args);
    const activeRuntime = runtime ?? defaultRuntime();
    const identity = await activeRuntime.identity();
    return {
      schema: "asana-cli.context-clear.v1",
      ...await activeRuntime.store.clear(identity, revision),
    };
  }

  throw new CliError(
    "usage",
    "Unknown context action; use alias, bind, activate, deactivate, quick, history, or clear",
  );
}
