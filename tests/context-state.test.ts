import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  FileContextStateStore,
  resolveContextStateDirectory,
} from "../src/context-state";
import type { GitStorageIdentity } from "../src/git-context";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asana-cli-context-state-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

const repositoryKey = `sha256:${"a".repeat(64)}`;
const firstWorktreeKey = `sha256:${"b".repeat(64)}`;
const secondWorktreeKey = `sha256:${"c".repeat(64)}`;
const firstIdentity: GitStorageIdentity = {
  repository_key: repositoryKey,
  worktree_key: firstWorktreeKey,
};
const secondIdentity: GitStorageIdentity = {
  repository_key: repositoryKey,
  worktree_key: secondWorktreeKey,
};

function aliasFile(baseDirectory: string): string {
  return join(baseDirectory, "aliases", `${"a".repeat(64)}.json`);
}

function worktreeFile(baseDirectory: string, worktreeKey: string): string {
  return join(
    baseDirectory,
    "worktrees",
    "a".repeat(64),
    `${worktreeKey.slice("sha256:".length)}.json`,
  );
}

async function capturedError(action: () => Promise<unknown>): Promise<Readonly<{
  code?: string;
  message?: string;
}>> {
  try {
    await action();
  } catch (error: unknown) {
    return error && typeof error === "object"
      ? error as Readonly<{ code?: string; message?: string }>
      : {};
  }
  throw new Error("Expected action to fail");
}

describe("owner-controlled context state", () => {
  test("shares aliases across linked worktrees while isolating active and recent state", async () => {
    const baseDirectory = await temporaryDirectory();
    const store = new FileContextStateStore({ baseDirectory });
    const alias = "task:platform/dev-014--local-context";

    const set = await store.setAlias(firstIdentity, alias, "1200000000001");
    expect(set).toEqual({
      revision: 1,
      aliases: [{ qualified_alias: alias, task_gid: "1200000000001" }],
    });
    expect(await store.listAliases(secondIdentity)).toEqual(set);

    const activated = await store.activate(firstIdentity, alias);
    expect(activated.active).toEqual({
      qualified_alias: alias,
      status: "resolved",
      task_gid: "1200000000001",
    });
    expect(await store.quick(secondIdentity)).toEqual({
      alias_revision: 1,
      worktree_revision: 0,
      active: null,
      recent: [],
    });

    const history = await store.history(firstIdentity);
    expect(activated.active).not.toBeNull();
    expect(history.recent).toEqual([activated.active!]);
    expect(history.worktree_revision).toBe(1);
  });

  test("requires explicit revision and target CAS for replace and remove", async () => {
    const store = new FileContextStateStore({ baseDirectory: await temporaryDirectory() });
    const alias = "task:platform/dev-014--cas-alias";
    await store.setAlias(firstIdentity, alias, "1200000000001");

    expect(await capturedError(() => store.replaceAlias(firstIdentity, {
      qualified_alias: alias,
      task_gid: "1200000000002",
      expected_task_gid: "1200000000001",
      expected_revision: 0,
    }))).toMatchObject({ code: "stale" });

    const replaced = await store.replaceAlias(firstIdentity, {
      qualified_alias: alias,
      task_gid: "1200000000002",
      expected_task_gid: "1200000000001",
      expected_revision: 1,
    });
    expect(replaced).toEqual({
      revision: 2,
      aliases: [{ qualified_alias: alias, task_gid: "1200000000002" }],
    });

    expect(await capturedError(() => store.removeAlias(firstIdentity, {
      qualified_alias: alias,
      expected_task_gid: "1200000000001",
      expected_revision: 2,
    }))).toMatchObject({ code: "stale" });

    expect(await store.removeAlias(firstIdentity, {
      qualified_alias: alias,
      expected_task_gid: "1200000000002",
      expected_revision: 2,
    })).toEqual({ revision: 3, aliases: [] });
  });

  test("enforces the bounded alias store without changing the last valid snapshot", async () => {
    const store = new FileContextStateStore({ baseDirectory: await temporaryDirectory() });
    for (let index = 1; index <= 100; index += 1) {
      await store.setAlias(
        firstIdentity,
        `task:platform/dev-${String(index).padStart(3, "0")}--bounded-alias-store`,
        "1200000000001",
      );
    }
    expect(await capturedError(() =>
      store.setAlias(
        firstIdentity,
        "task:platform/dev-101--bounded-alias-store",
        "1200000000001",
      )
    )).toMatchObject({ code: "conflict" });
    const snapshot = await store.listAliases(firstIdentity);
    expect(snapshot.revision).toBe(100);
    expect(snapshot.aliases).toHaveLength(100);
    expect(snapshot.aliases[0]?.qualified_alias)
      .toBe("task:platform/dev-001--bounded-alias-store");
    expect(snapshot.aliases.at(-1)?.qualified_alias)
      .toBe("task:platform/dev-100--bounded-alias-store");
  });

  test("bounds recent history, reports removed active aliases as stale, and erases explicitly", async () => {
    const baseDirectory = await temporaryDirectory();
    const store = new FileContextStateStore({ baseDirectory });
    const aliases = Array.from({ length: 22 }, (_, index) =>
      `task:platform/dev-${String(index + 1).padStart(3, "0")}--bounded-history`
    );
    for (const [index, alias] of aliases.entries()) {
      await store.setAlias(firstIdentity, alias, String(1200000000000 + index));
      await store.activate(firstIdentity, alias);
    }

    const history = await store.history(firstIdentity);
    expect(history.recent).toHaveLength(20);
    expect(history.recent[0]?.qualified_alias).toBe(aliases.at(-1)!);
    expect(history.recent.at(-1)?.qualified_alias).toBe(aliases[2]!);

    const active = aliases.at(-1)!;
    const activeTask = String(1200000000000 + aliases.length - 1);
    const aliasSnapshot = await store.listAliases(firstIdentity);
    await store.removeAlias(firstIdentity, {
      qualified_alias: active,
      expected_task_gid: activeTask,
      expected_revision: aliasSnapshot.revision,
    });
    expect((await store.quick(firstIdentity)).active).toEqual({
      qualified_alias: active,
      status: "stale",
    });

    expect(await capturedError(() =>
      store.clear(firstIdentity, history.worktree_revision - 1)
    )).toMatchObject({ code: "stale" });
    expect(await store.clear(firstIdentity, history.worktree_revision)).toEqual({
      cleared: true,
      previous_revision: history.worktree_revision,
      worktree_revision: history.worktree_revision + 1,
    });
    expect(await store.history(firstIdentity)).toMatchObject({
      worktree_revision: history.worktree_revision + 1,
      active: null,
      recent: [],
    });

    const reactivated = await store.activate(firstIdentity, aliases[0]!);
    expect(reactivated.worktree_revision).toBe(history.worktree_revision + 2);
    expect(await capturedError(() =>
      store.clear(firstIdentity, history.worktree_revision)
    )).toMatchObject({ code: "stale" });
  });

  test("serializes concurrent alias updates and refuses stale locks", async () => {
    const baseDirectory = await temporaryDirectory();
    const store = new FileContextStateStore({
      baseDirectory,
      lockTimeoutMs: 2000,
      lockRetryMs: 1,
    });
    await Promise.all([
      store.setAlias(firstIdentity, "task:platform/dev-001--first", "1200000000001"),
      store.setAlias(firstIdentity, "task:platform/dev-002--second", "1200000000002"),
    ]);
    expect(await store.listAliases(firstIdentity)).toMatchObject({
      revision: 2,
      aliases: [
        { qualified_alias: "task:platform/dev-001--first" },
        { qualified_alias: "task:platform/dev-002--second" },
      ],
    });

    const lockedStore = new FileContextStateStore({
      baseDirectory,
      lockTimeoutMs: 0,
      lockRetryMs: 1,
    });
    const lockPath = `${aliasFile(baseDirectory)}.lock`;
    await writeFile(lockPath, `${JSON.stringify({
      schema: "asana-cli.context-lock.v1",
      lock_id: randomUUID(),
      pid: process.pid,
    })}\n`, { mode: 0o600 });
    expect(await capturedError(() =>
      lockedStore.setAlias(firstIdentity, "task:platform/dev-003--third", "1200000000003")
    )).toMatchObject({ code: "storage-locked" });

    await rm(lockPath);
    await writeFile(lockPath, "{}\n", { mode: 0o600 });
    expect(await capturedError(() =>
      lockedStore.setAlias(firstIdentity, "task:platform/dev-003--third", "1200000000003")
    )).toMatchObject({ code: "storage-invalid" });
  });

  test("uses restrictive files containing only bounded opaque metadata", async () => {
    const baseDirectory = await temporaryDirectory();
    const store = new FileContextStateStore({ baseDirectory });
    const alias = "task:platform/dev-014--no-sensitive-content";
    await store.setAlias(firstIdentity, alias, "1200000000001");
    await store.activate(firstIdentity, alias);

    const aliasPath = aliasFile(baseDirectory);
    const worktreePath = worktreeFile(baseDirectory, firstWorktreeKey);
    expect((await stat(dirname(aliasPath))).mode & 0o777).toBe(0o700);
    expect((await stat(aliasPath)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(worktreePath))).mode & 0o777).toBe(0o700);
    expect((await stat(worktreePath)).mode & 0o777).toBe(0o600);

    const serialized = `${await readFile(aliasPath, "utf8")}${await readFile(worktreePath, "utf8")}`;
    expect(serialized).not.toContain(baseDirectory);
    expect(serialized).not.toContain("github.com");
    expect(serialized).not.toContain("feature/private-branch");
    expect(serialized).not.toContain("ASANA_ACCESS_TOKEN");
    expect(serialized).not.toContain("task comment body");

    await chmod(aliasPath, 0o644);
    expect(await capturedError(() => store.listAliases(firstIdentity))).toMatchObject({
      code: "storage-invalid",
    });

    await chmod(aliasPath, 0o600);
    await chmod(baseDirectory, 0o755);
    expect(await capturedError(() => store.listAliases(firstIdentity))).toMatchObject({
      code: "storage-invalid",
    });
  });

  test("rejects duplicate JSON keys, identity substitution, and linked state files", async () => {
    const baseDirectory = await temporaryDirectory();
    const store = new FileContextStateStore({ baseDirectory });
    await store.setAlias(
      firstIdentity,
      "task:platform/dev-014--adversarial-storage",
      "1200000000001",
    );
    const path = aliasFile(baseDirectory);
    const validSource = await readFile(path, "utf8");

    await writeFile(
      path,
      validSource.replace('"revision":1', '"revision":1,"revision":1'),
      { mode: 0o600 },
    );
    expect(await capturedError(() => store.listAliases(firstIdentity))).toMatchObject({
      code: "storage-invalid",
    });

    const substituted = {
      ...JSON.parse(validSource) as Record<string, unknown>,
      repository_key: `sha256:${"f".repeat(64)}`,
    };
    await writeFile(path, `${JSON.stringify(substituted)}\n`, { mode: 0o600 });
    expect(await capturedError(() => store.listAliases(firstIdentity))).toMatchObject({
      code: "storage-invalid",
    });

    const target = join(baseDirectory, "linked-target.json");
    await writeFile(target, validSource, { mode: 0o600 });
    await rm(path);
    await symlink(target, path);
    expect(await capturedError(() => store.listAliases(firstIdentity))).toMatchObject({
      code: "storage-invalid",
    });
  });

  test("resolves supported state roots without accepting relative environment paths", () => {
    expect(resolveContextStateDirectory(
      { HOME: "/Users/example", XDG_STATE_HOME: "/ignored-on-macos" },
      "darwin",
    )).toBe("/Users/example/Library/Application Support/asana-cli/context");
    expect(resolveContextStateDirectory(
      { HOME: "/home/example", XDG_STATE_HOME: "/state" },
      "linux",
    )).toBe("/state/asana-cli/context");
    expect(() => resolveContextStateDirectory(
      { HOME: "relative" },
      "linux",
    )).toThrow("absolute HOME");
  });
});
