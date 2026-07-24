import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { CliError } from "./errors";
import {
  gitStorageIdentitySchema,
  type GitStorageIdentity,
} from "./git-context";
import {
  parseRepositoryContextJson,
  qualifiedTaskAliasSchema,
} from "./repository-context";
import { gidSchema } from "./schemas";
import {
  assertSupportedRuntimePlatform,
  type SupportedRuntimePlatform,
} from "./platform-support";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_STATE_BYTES = 65_536;
const MAX_ALIASES = 100;
const MAX_RECENT_ALIASES = 20;
const MAX_REVISION = 2_147_483_647;

const stateRevisionSchema = z.number().int().min(1).max(MAX_REVISION);
const expectedRevisionSchema = z.number().int().min(0).max(MAX_REVISION);
const opaqueKeySchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const nodeErrorSchema = z.object({ code: z.string() });

export const contextAliasEntrySchema = z.strictObject({
  qualified_alias: qualifiedTaskAliasSchema,
  task_gid: gidSchema,
});

export type ContextAliasEntry = z.output<typeof contextAliasEntrySchema>;

export const sharedAliasStoreSchema = z.strictObject({
  schema: z.literal("asana-cli.shared-aliases.v1"),
  revision: stateRevisionSchema,
  repository_key: opaqueKeySchema,
  aliases: z.array(contextAliasEntrySchema).max(MAX_ALIASES),
}).superRefine((store, context) => {
  const aliases = new Set<string>();
  for (const [index, entry] of store.aliases.entries()) {
    if (aliases.has(entry.qualified_alias)) {
      context.addIssue({
        code: "custom",
        path: ["aliases", index, "qualified_alias"],
        message: "Shared aliases must be unique",
      });
    }
    aliases.add(entry.qualified_alias);
  }
});

export type SharedAliasStore = z.output<typeof sharedAliasStoreSchema>;

export const worktreeContextStateSchema = z.strictObject({
  schema: z.literal("asana-cli.worktree-context.v1"),
  revision: stateRevisionSchema,
  repository_key: opaqueKeySchema,
  worktree_key: opaqueKeySchema,
  active_alias: qualifiedTaskAliasSchema.nullable(),
  recent_aliases: z.array(qualifiedTaskAliasSchema).max(MAX_RECENT_ALIASES),
}).superRefine((state, context) => {
  const aliases = new Set<string>();
  for (const [index, alias] of state.recent_aliases.entries()) {
    if (aliases.has(alias)) {
      context.addIssue({
        code: "custom",
        path: ["recent_aliases", index],
        message: "Recent aliases must be unique",
      });
    }
    aliases.add(alias);
  }
  if (state.active_alias !== null && state.recent_aliases[0] !== state.active_alias) {
    context.addIssue({
      code: "custom",
      path: ["active_alias"],
      message: "Active alias must be the first recent alias",
    });
  }
});

export type WorktreeContextState = z.output<typeof worktreeContextStateSchema>;

const contextStateEnvironmentSchema = z.object({
  HOME: z.string().min(1).optional(),
  XDG_STATE_HOME: z.string().min(1).optional(),
});

export type ContextStatePlatform = SupportedRuntimePlatform;

export type AliasSnapshot = Readonly<{
  revision: number;
  aliases: readonly ContextAliasEntry[];
}>;

export type WorktreeSnapshot = Readonly<{
  revision: number;
  active_alias: string | null;
  recent_aliases: readonly string[];
}>;

export type ResolvedContextAlias = Readonly<{
  qualified_alias: string;
  status: "resolved";
  task_gid: string;
}> | Readonly<{
  qualified_alias: string;
  status: "stale";
}>;

export type QuickContext = Readonly<{
  alias_revision: number;
  worktree_revision: number;
  active: ResolvedContextAlias | null;
  recent: readonly ResolvedContextAlias[];
}>;

export const worktreeTaskContextDataSchema = z.strictObject({
  schema: z.literal("asana-cli.worktree-task.v1"),
  worktree_revision: expectedRevisionSchema,
  task: z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("unbound"),
    }),
    z.strictObject({
      status: z.literal("bound"),
      qualified_alias: qualifiedTaskAliasSchema,
      task_gid: gidSchema,
    }),
    z.strictObject({
      status: z.literal("stale"),
      qualified_alias: qualifiedTaskAliasSchema,
    }),
  ]),
});

export type WorktreeTaskContextData = z.output<typeof worktreeTaskContextDataSchema>;

export function worktreeTaskContextData(context: QuickContext): WorktreeTaskContextData {
  const task = context.active === null
    ? { status: "unbound" as const }
    : context.active.status === "resolved"
      ? {
        status: "bound" as const,
        qualified_alias: context.active.qualified_alias,
        task_gid: context.active.task_gid,
      }
      : {
        status: "stale" as const,
        qualified_alias: context.active.qualified_alias,
      };
  return worktreeTaskContextDataSchema.parse({
    schema: "asana-cli.worktree-task.v1",
    worktree_revision: context.worktree_revision,
    task,
  });
}

export interface ContextStateStore {
  listAliases(identity: GitStorageIdentity): Promise<AliasSnapshot>;
  ensureAlias(
    identity: GitStorageIdentity,
    qualifiedAlias: string,
    taskGid: string,
  ): Promise<Readonly<AliasSnapshot & { created: boolean }>>;
  setAlias(
    identity: GitStorageIdentity,
    qualifiedAlias: string,
    taskGid: string,
  ): Promise<AliasSnapshot>;
  replaceAlias(
    identity: GitStorageIdentity,
    input: Readonly<{
      qualified_alias: string;
      task_gid: string;
      expected_task_gid: string;
      expected_revision: number;
    }>,
  ): Promise<AliasSnapshot>;
  removeAlias(
    identity: GitStorageIdentity,
    input: Readonly<{
      qualified_alias: string;
      expected_task_gid: string;
      expected_revision: number;
    }>,
  ): Promise<AliasSnapshot>;
  activate(identity: GitStorageIdentity, qualifiedAlias: string): Promise<QuickContext>;
  quick(identity: GitStorageIdentity): Promise<QuickContext>;
  history(identity: GitStorageIdentity): Promise<QuickContext>;
  clear(identity: GitStorageIdentity, expectedRevision: number): Promise<Readonly<{
    cleared: boolean;
    previous_revision: number;
    worktree_revision: number;
  }>>;
  deactivate(identity: GitStorageIdentity, qualifiedAlias: string): Promise<Readonly<{
    deactivated: boolean;
    previous_revision: number;
    worktree_revision: number;
  }>>;
}

export function resolveContextStateDirectory(
  environment: Record<string, string | undefined> = process.env,
  platform: ContextStatePlatform = assertSupportedRuntimePlatform(),
): string {
  const parsed = contextStateEnvironmentSchema.parse(environment);
  if (platform === "linux" && parsed.XDG_STATE_HOME) {
    if (!isAbsolute(parsed.XDG_STATE_HOME)) throw new Error("XDG_STATE_HOME must be absolute");
    return join(parsed.XDG_STATE_HOME, "asana-cli", "context");
  }
  if (!parsed.HOME || !isAbsolute(parsed.HOME)) {
    throw new Error("An absolute HOME is required for local context state");
  }
  return platform === "darwin"
    ? join(parsed.HOME, "Library", "Application Support", "asana-cli", "context")
    : join(parsed.HOME, ".local", "state", "asana-cli", "context");
}

function contextStateStorageInvalid(): CliError {
  return new CliError("storage-invalid", "Local context state is unavailable or unsafe");
}

function nodeErrorCode(error: unknown): string | undefined {
  const parsed = nodeErrorSchema.safeParse(error);
  return parsed.success ? parsed.data.code : undefined;
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function keySegment(value: string): string {
  return opaqueKeySchema.parse(value).slice("sha256:".length);
}

function cloneAliases(value: readonly ContextAliasEntry[]): ContextAliasEntry[] {
  return value.map((entry) => ({ ...entry }));
}

function aliasSnapshot(store: SharedAliasStore | null): AliasSnapshot {
  return {
    revision: store?.revision ?? 0,
    aliases: cloneAliases(store?.aliases ?? []),
  };
}

function worktreeSnapshot(state: WorktreeContextState | null): WorktreeSnapshot {
  return {
    revision: state?.revision ?? 0,
    active_alias: state?.active_alias ?? null,
    recent_aliases: [...(state?.recent_aliases ?? [])],
  };
}

function nextRevision(current: number): number {
  if (current >= MAX_REVISION) {
    throw new CliError("conflict", "Local context state revision is exhausted");
  }
  return current + 1;
}

function requireExpectedRevision(actual: number, expected: number): void {
  if (actual !== expectedRevisionSchema.parse(expected)) {
    throw new CliError("stale", "Local context state changed; inspect it and retry explicitly", undefined, {
      expected_revision: expected,
      actual_revision: actual,
    });
  }
}

function resolveAlias(
  aliasByName: ReadonlyMap<string, ContextAliasEntry>,
  qualifiedAlias: string,
): ResolvedContextAlias {
  const alias = aliasByName.get(qualifiedAlias);
  return alias
    ? {
      qualified_alias: alias.qualified_alias,
      status: "resolved",
      task_gid: alias.task_gid,
    }
    : {
      qualified_alias: qualifiedTaskAliasSchema.parse(qualifiedAlias),
      status: "stale",
    };
}

type FileContextStateStoreOptions = Readonly<{
  baseDirectory?: string;
  environment?: Record<string, string | undefined>;
  platform?: ContextStatePlatform;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
}>;

const contextLockSchema = z.strictObject({
  schema: z.literal("asana-cli.context-lock.v1"),
  lock_id: z.uuid(),
  pid: z.number().int().nonnegative(),
});

type ContextLock = z.output<typeof contextLockSchema>;
type FileIdentity = Readonly<{ dev: number; ino: number }>;

export class FileContextStateStore implements ContextStateStore {
  readonly baseDirectory: string;
  readonly #lockTimeoutMs: number;
  readonly #lockRetryMs: number;

  constructor(options: FileContextStateStoreOptions = {}) {
    const baseDirectory = options.baseDirectory ?? resolveContextStateDirectory(
      options.environment,
      options.platform,
    );
    if (!isAbsolute(baseDirectory)) {
      throw new Error("Context state base directory must be absolute");
    }
    this.baseDirectory = resolve(baseDirectory);
    this.#lockTimeoutMs = z.number().int().nonnegative().max(30_000).parse(
      options.lockTimeoutMs ?? 1_000,
    );
    this.#lockRetryMs = z.number().int().positive().max(1_000).parse(
      options.lockRetryMs ?? 10,
    );
  }

  async listAliases(identityValue: GitStorageIdentity): Promise<AliasSnapshot> {
    const identity = gitStorageIdentitySchema.parse(identityValue);
    return aliasSnapshot(await this.#readAliasStore(identity));
  }

  async setAlias(
    identityValue: GitStorageIdentity,
    qualifiedAliasValue: string,
    taskGidValue: string,
  ): Promise<AliasSnapshot> {
    const identity = gitStorageIdentitySchema.parse(identityValue);
    const qualifiedAlias = qualifiedTaskAliasSchema.parse(qualifiedAliasValue);
    const taskGid = gidSchema.parse(taskGidValue);
    const path = this.#aliasStorePath(identity);
    return this.#withLock(path, async () => {
      const current = await this.#readAliasStore(identity);
      if (current?.aliases.some((entry) => entry.qualified_alias === qualifiedAlias)) {
        throw new CliError("conflict", "Alias already exists; use explicit CAS replace");
      }
      const aliases = [
        ...(current?.aliases ?? []),
        { qualified_alias: qualifiedAlias, task_gid: taskGid },
      ].sort((left, right) => compareText(left.qualified_alias, right.qualified_alias));
      if (aliases.length > MAX_ALIASES) {
        throw new CliError("conflict", `A repository may store at most ${MAX_ALIASES} aliases`);
      }
      const next = sharedAliasStoreSchema.parse({
        schema: "asana-cli.shared-aliases.v1",
        revision: nextRevision(current?.revision ?? 0),
        repository_key: identity.repository_key,
        aliases,
      });
      await this.#writeJson(path, next);
      return aliasSnapshot(next);
    });
  }

  async ensureAlias(
    identityValue: GitStorageIdentity,
    qualifiedAliasValue: string,
    taskGidValue: string,
  ): Promise<Readonly<AliasSnapshot & { created: boolean }>> {
    const identity = gitStorageIdentitySchema.parse(identityValue);
    const qualifiedAlias = qualifiedTaskAliasSchema.parse(qualifiedAliasValue);
    const taskGid = gidSchema.parse(taskGidValue);
    const path = this.#aliasStorePath(identity);
    return this.#withLock(path, async () => {
      const current = await this.#readAliasStore(identity);
      const snapshot = aliasSnapshot(current);
      const existing = snapshot.aliases.find((entry) =>
        entry.qualified_alias === qualifiedAlias
      );
      if (existing) {
        if (existing.task_gid !== taskGid) {
          throw new CliError(
            "conflict",
            "Alias is bound to a different task; use explicit CAS replace",
          );
        }
        return { ...snapshot, created: false };
      }
      const aliases = [
        ...snapshot.aliases,
        { qualified_alias: qualifiedAlias, task_gid: taskGid },
      ].sort((left, right) => compareText(left.qualified_alias, right.qualified_alias));
      if (aliases.length > MAX_ALIASES) {
        throw new CliError("conflict", `A repository may store at most ${MAX_ALIASES} aliases`);
      }
      const next = sharedAliasStoreSchema.parse({
        schema: "asana-cli.shared-aliases.v1",
        revision: nextRevision(snapshot.revision),
        repository_key: identity.repository_key,
        aliases,
      });
      await this.#writeJson(path, next);
      return { ...aliasSnapshot(next), created: true };
    });
  }

  async replaceAlias(
    identityValue: GitStorageIdentity,
    inputValue: Readonly<{
      qualified_alias: string;
      task_gid: string;
      expected_task_gid: string;
      expected_revision: number;
    }>,
  ): Promise<AliasSnapshot> {
    const identity = gitStorageIdentitySchema.parse(identityValue);
    const input = z.strictObject({
      qualified_alias: qualifiedTaskAliasSchema,
      task_gid: gidSchema,
      expected_task_gid: gidSchema,
      expected_revision: expectedRevisionSchema,
    }).parse(inputValue);
    const path = this.#aliasStorePath(identity);
    return this.#withLock(path, async () => {
      const current = await this.#readAliasStore(identity);
      const snapshot = aliasSnapshot(current);
      requireExpectedRevision(snapshot.revision, input.expected_revision);
      const existing = snapshot.aliases.find((entry) =>
        entry.qualified_alias === input.qualified_alias
      );
      if (!existing) throw new CliError("not-found", "Alias does not exist");
      if (existing.task_gid !== input.expected_task_gid) {
        throw new CliError("stale", "Alias target changed; inspect it and retry explicitly");
      }
      const next = sharedAliasStoreSchema.parse({
        schema: "asana-cli.shared-aliases.v1",
        revision: nextRevision(snapshot.revision),
        repository_key: identity.repository_key,
        aliases: snapshot.aliases.map((entry) =>
          entry.qualified_alias === input.qualified_alias
            ? { qualified_alias: entry.qualified_alias, task_gid: input.task_gid }
            : entry
        ),
      });
      await this.#writeJson(path, next);
      return aliasSnapshot(next);
    });
  }

  async removeAlias(
    identityValue: GitStorageIdentity,
    inputValue: Readonly<{
      qualified_alias: string;
      expected_task_gid: string;
      expected_revision: number;
    }>,
  ): Promise<AliasSnapshot> {
    const identity = gitStorageIdentitySchema.parse(identityValue);
    const input = z.strictObject({
      qualified_alias: qualifiedTaskAliasSchema,
      expected_task_gid: gidSchema,
      expected_revision: expectedRevisionSchema,
    }).parse(inputValue);
    const path = this.#aliasStorePath(identity);
    return this.#withLock(path, async () => {
      const current = await this.#readAliasStore(identity);
      const snapshot = aliasSnapshot(current);
      requireExpectedRevision(snapshot.revision, input.expected_revision);
      const existing = snapshot.aliases.find((entry) =>
        entry.qualified_alias === input.qualified_alias
      );
      if (!existing) throw new CliError("not-found", "Alias does not exist");
      if (existing.task_gid !== input.expected_task_gid) {
        throw new CliError("stale", "Alias target changed; inspect it and retry explicitly");
      }
      const next = sharedAliasStoreSchema.parse({
        schema: "asana-cli.shared-aliases.v1",
        revision: nextRevision(snapshot.revision),
        repository_key: identity.repository_key,
        aliases: snapshot.aliases.filter((entry) =>
          entry.qualified_alias !== input.qualified_alias
        ),
      });
      await this.#writeJson(path, next);
      return aliasSnapshot(next);
    });
  }

  async activate(
    identityValue: GitStorageIdentity,
    qualifiedAliasValue: string,
  ): Promise<QuickContext> {
    const identity = gitStorageIdentitySchema.parse(identityValue);
    const qualifiedAlias = qualifiedTaskAliasSchema.parse(qualifiedAliasValue);
    const aliases = await this.#readAliasStore(identity);
    if (!aliases?.aliases.some((entry) => entry.qualified_alias === qualifiedAlias)) {
      throw new CliError("not-found", "Alias does not exist");
    }

    const path = this.#worktreeStatePath(identity);
    await this.#withLock(path, async () => {
      const current = await this.#readWorktreeState(identity);
      if (
        current?.active_alias === qualifiedAlias &&
        current.recent_aliases[0] === qualifiedAlias
      ) {
        return;
      }
      const recentAliases = [
        qualifiedAlias,
        ...(current?.recent_aliases ?? []).filter((alias) => alias !== qualifiedAlias),
      ].slice(0, MAX_RECENT_ALIASES);
      const next = worktreeContextStateSchema.parse({
        schema: "asana-cli.worktree-context.v1",
        revision: nextRevision(current?.revision ?? 0),
        repository_key: identity.repository_key,
        worktree_key: identity.worktree_key,
        active_alias: qualifiedAlias,
        recent_aliases: recentAliases,
      });
      await this.#writeJson(path, next);
    });
    return this.quick(identity);
  }

  async quick(identityValue: GitStorageIdentity): Promise<QuickContext> {
    return this.#projectContext(gitStorageIdentitySchema.parse(identityValue), false);
  }

  async history(identityValue: GitStorageIdentity): Promise<QuickContext> {
    return this.#projectContext(gitStorageIdentitySchema.parse(identityValue), true);
  }

  async clear(
    identityValue: GitStorageIdentity,
    expectedRevisionValue: number,
  ): Promise<Readonly<{
    cleared: boolean;
    previous_revision: number;
    worktree_revision: number;
  }>> {
    const identity = gitStorageIdentitySchema.parse(identityValue);
    const expectedRevision = expectedRevisionSchema.parse(expectedRevisionValue);
    const path = this.#worktreeStatePath(identity);
    return this.#withLock(path, async () => {
      const current = await this.#readWorktreeState(identity);
      const snapshot = worktreeSnapshot(current);
      requireExpectedRevision(snapshot.revision, expectedRevision);
      if (
        !current ||
        (current.active_alias === null && current.recent_aliases.length === 0)
      ) {
        return {
          cleared: false,
          previous_revision: snapshot.revision,
          worktree_revision: snapshot.revision,
        };
      }
      const next = worktreeContextStateSchema.parse({
        schema: "asana-cli.worktree-context.v1",
        revision: nextRevision(current.revision),
        repository_key: identity.repository_key,
        worktree_key: identity.worktree_key,
        active_alias: null,
        recent_aliases: [],
      });
      await this.#writeJson(path, next);
      return {
        cleared: true,
        previous_revision: current.revision,
        worktree_revision: next.revision,
      };
    });
  }

  async deactivate(
    identityValue: GitStorageIdentity,
    qualifiedAliasValue: string,
  ): Promise<Readonly<{
    deactivated: boolean;
    previous_revision: number;
    worktree_revision: number;
  }>> {
    const identity = gitStorageIdentitySchema.parse(identityValue);
    const qualifiedAlias = qualifiedTaskAliasSchema.parse(qualifiedAliasValue);
    const path = this.#worktreeStatePath(identity);
    return this.#withLock(path, async () => {
      const current = await this.#readWorktreeState(identity);
      const snapshot = worktreeSnapshot(current);
      if (!current || current.active_alias === null) {
        return {
          deactivated: false,
          previous_revision: snapshot.revision,
          worktree_revision: snapshot.revision,
        };
      }
      if (current.active_alias !== qualifiedAlias) {
        throw new CliError(
          "conflict",
          "A different alias is active in this worktree; refusing lifecycle cleanup",
        );
      }
      const next = worktreeContextStateSchema.parse({
        schema: "asana-cli.worktree-context.v1",
        revision: nextRevision(current.revision),
        repository_key: identity.repository_key,
        worktree_key: identity.worktree_key,
        active_alias: null,
        recent_aliases: [],
      });
      await this.#writeJson(path, next);
      return {
        deactivated: true,
        previous_revision: current.revision,
        worktree_revision: next.revision,
      };
    });
  }

  async #projectContext(
    identity: GitStorageIdentity,
    includeHistory: boolean,
  ): Promise<QuickContext> {
    const [aliasStore, worktreeState] = await Promise.all([
      this.#readAliasStore(identity),
      this.#readWorktreeState(identity),
    ]);
    const aliases = aliasSnapshot(aliasStore);
    const worktree = worktreeSnapshot(worktreeState);
    const aliasByName = new Map(aliases.aliases.map((entry) => [entry.qualified_alias, entry]));
    const recent = includeHistory
      ? worktree.recent_aliases.map((alias) => resolveAlias(aliasByName, alias))
      : [];
    return {
      alias_revision: aliases.revision,
      worktree_revision: worktree.revision,
      active: worktree.active_alias === null
        ? null
        : resolveAlias(aliasByName, worktree.active_alias),
      recent,
    };
  }

  #aliasStorePath(identity: GitStorageIdentity): string {
    return join(
      this.baseDirectory,
      "aliases",
      `${keySegment(identity.repository_key)}.json`,
    );
  }

  #worktreeStatePath(identity: GitStorageIdentity): string {
    return join(
      this.baseDirectory,
      "worktrees",
      keySegment(identity.repository_key),
      `${keySegment(identity.worktree_key)}.json`,
    );
  }

  async #readAliasStore(identity: GitStorageIdentity): Promise<SharedAliasStore | null> {
    const value = await this.#readJson(this.#aliasStorePath(identity));
    if (value === null) return null;
    const store = sharedAliasStoreSchema.safeParse(value);
    if (!store.success || store.data.repository_key !== identity.repository_key) {
      throw contextStateStorageInvalid();
    }
    return store.data;
  }

  async #readWorktreeState(identity: GitStorageIdentity): Promise<WorktreeContextState | null> {
    const value = await this.#readJson(this.#worktreeStatePath(identity));
    if (value === null) return null;
    const state = worktreeContextStateSchema.safeParse(value);
    if (
      !state.success ||
      state.data.repository_key !== identity.repository_key ||
      state.data.worktree_key !== identity.worktree_key
    ) {
      throw contextStateStorageInvalid();
    }
    return state.data;
  }

  #managedDirectories(path: string): readonly string[] {
    const child = relative(this.baseDirectory, resolve(path));
    if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      throw contextStateStorageInvalid();
    }
    const directories = [this.baseDirectory];
    let current = this.baseDirectory;
    for (const segment of child.split(sep).filter(Boolean)) {
      current = join(current, segment);
      directories.push(current);
    }
    return directories;
  }

  async #inspectManagedDirectories(path: string): Promise<boolean> {
    for (const directory of this.#managedDirectories(path)) {
      let metadata;
      try {
        metadata = await lstat(directory);
      } catch (error: unknown) {
        if (nodeErrorCode(error) === "ENOENT") return false;
        throw contextStateStorageInvalid();
      }
      if (
        metadata.isSymbolicLink() ||
        !metadata.isDirectory() ||
        (metadata.mode & 0o077) !== 0
      ) {
        throw contextStateStorageInvalid();
      }
      this.#assertOwner(metadata.uid);
    }
    return true;
  }

  async #ensureDirectory(path: string): Promise<void> {
    try {
      await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
      for (const directory of this.#managedDirectories(path)) {
        const metadata = await lstat(directory);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw contextStateStorageInvalid();
        }
        this.#assertOwner(metadata.uid);
        await chmod(directory, DIRECTORY_MODE);
      }
    } catch (error: unknown) {
      if (error instanceof CliError) throw error;
      throw contextStateStorageInvalid();
    }
  }

  #assertOwner(owner: number): void {
    if (typeof process.getuid === "function" && owner !== process.getuid()) {
      throw contextStateStorageInvalid();
    }
  }

  async #readJson(path: string): Promise<unknown | null> {
    if (!await this.#inspectManagedDirectories(dirname(path))) return null;
    let initial;
    try {
      initial = await lstat(path);
    } catch (error: unknown) {
      if (nodeErrorCode(error) === "ENOENT") return null;
      throw contextStateStorageInvalid();
    }
    if (
      initial.isSymbolicLink() ||
      !initial.isFile() ||
      (initial.mode & 0o077) !== 0 ||
      initial.size <= 0 ||
      initial.size > MAX_STATE_BYTES
    ) {
      throw contextStateStorageInvalid();
    }
    this.#assertOwner(initial.uid);

    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const metadata = await handle.stat();
      if (
        !metadata.isFile() ||
        metadata.dev !== initial.dev ||
        metadata.ino !== initial.ino ||
        metadata.size !== initial.size
      ) {
        throw contextStateStorageInvalid();
      }
      const source = await handle.readFile("utf8");
      if (Buffer.byteLength(source, "utf8") !== metadata.size) {
        throw contextStateStorageInvalid();
      }
      return parseRepositoryContextJson(source);
    } catch (error: unknown) {
      if (error instanceof CliError) throw error;
      throw contextStateStorageInvalid();
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async #writeJson(path: string, value: unknown): Promise<void> {
    const serialized = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
      throw contextStateStorageInvalid();
    }
    const directory = dirname(path);
    await this.#ensureDirectory(directory);
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    let handle;
    let temporaryIdentity: FileIdentity | undefined;
    try {
      handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        FILE_MODE,
      );
      const metadata = await handle.stat();
      temporaryIdentity = { dev: metadata.dev, ino: metadata.ino };
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(temporary, FILE_MODE);
      await rename(temporary, path);
      await chmod(path, FILE_MODE);
      await this.#syncDirectory(directory);
    } catch (error: unknown) {
      await handle?.close().catch(() => undefined);
      if (temporaryIdentity) {
        await this.#removeOwnedPartialFile(temporary, temporaryIdentity);
      }
      if (error instanceof CliError) throw error;
      throw contextStateStorageInvalid();
    }
  }

  async #syncDirectory(path: string): Promise<void> {
    const directory = await open(path, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  async #withLock<Result>(statePath: string, action: () => Promise<Result>): Promise<Result> {
    const directory = dirname(statePath);
    await this.#ensureDirectory(directory);
    const lockPath = `${statePath}.lock`;
    const deadline = Date.now() + this.#lockTimeoutMs;
    let lock: ContextLock | undefined;

    for (;;) {
      const candidate = contextLockSchema.parse({
        schema: "asana-cli.context-lock.v1",
        lock_id: randomUUID(),
        pid: process.pid,
      });
      let handle;
      let lockIdentity: FileIdentity | undefined;
      try {
        handle = await open(
          lockPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          FILE_MODE,
        );
        const metadata = await handle.stat();
        lockIdentity = { dev: metadata.dev, ino: metadata.ino };
        await handle.writeFile(`${JSON.stringify(candidate)}\n`, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        await chmod(lockPath, FILE_MODE);
        lock = candidate;
        break;
      } catch (error: unknown) {
        await handle?.close().catch(() => undefined);
        if (lockIdentity) {
          await this.#removeOwnedPartialFile(lockPath, lockIdentity);
        }
        if (nodeErrorCode(error) !== "EEXIST") throw contextStateStorageInvalid();
        if (Date.now() >= deadline) {
          const existing: unknown = await this.#readJson(lockPath);
          if (!contextLockSchema.safeParse(existing).success) {
            throw contextStateStorageInvalid();
          }
          throw new CliError("storage-locked", "Local context state is locked; refusing unsafe recovery");
        }
        await Bun.sleep(this.#lockRetryMs);
      }
    }

    try {
      return await action();
    } finally {
      if (lock) await this.#releaseLock(lockPath, lock);
    }
  }

  async #removeOwnedPartialFile(path: string, identity: FileIdentity): Promise<void> {
    try {
      const current = await lstat(path);
      if (
        current.isSymbolicLink() ||
        !current.isFile() ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino
      ) {
        return;
      }
      await rm(path);
      await this.#syncDirectory(dirname(path));
    } catch (error: unknown) {
      if (nodeErrorCode(error) === "ENOENT") return;
      throw contextStateStorageInvalid();
    }
  }

  async #releaseLock(path: string, owned: ContextLock): Promise<void> {
    try {
      const value: unknown = await this.#readJson(path);
      const current = contextLockSchema.parse(value);
      if (current.lock_id !== owned.lock_id) throw contextStateStorageInvalid();
      await rm(path);
      await this.#syncDirectory(dirname(path));
    } catch (error: unknown) {
      if (error instanceof CliError) throw error;
      throw contextStateStorageInvalid();
    }
  }
}
