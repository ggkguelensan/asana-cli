import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "../src/args";
import { runCli } from "../src/cli";
import { runContextCommand } from "../src/context-cli";
import { FileContextStateStore } from "../src/context-state";
import type { GitStorageIdentity } from "../src/git-context";

const projectRoot = resolve(import.meta.dir, "..");
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asana-cli-context-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

const identity: GitStorageIdentity = {
  repository_key: `sha256:${"d".repeat(64)}`,
  worktree_key: `sha256:${"e".repeat(64)}`,
};

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

describe("human local context CLI", () => {
  test("routes the complete alias, activation, history, and erasure lifecycle", async () => {
    const store = new FileContextStateStore({ baseDirectory: await temporaryDirectory() });
    const runtime = { store, identity: async () => identity };
    const alias = "task:platform/dev-014--cli-lifecycle";

    expect(await runContextCommand(parseArgs([
      "context", "alias", "set", alias, "--task", "1200000000001",
    ]), runtime)).toMatchObject({
      schema: "asana-cli.context-alias-list.v1",
      revision: 1,
    });
    expect(await runContextCommand(parseArgs([
      "context", "alias", "replace", alias,
      "--task", "1200000000002",
      "--expected-task", "1200000000001",
      "--revision", "1",
    ]), runtime)).toMatchObject({
      revision: 2,
      aliases: [{ task_gid: "1200000000002" }],
    });
    expect(await runContextCommand(parseArgs([
      "context", "activate", alias,
    ]), runtime)).toMatchObject({
      schema: "asana-cli.quick-context.v1",
      active: { task_gid: "1200000000002", status: "resolved" },
    });
    expect(await runContextCommand(parseArgs([
      "context", "bind", alias, "--task", "1200000000002",
    ]), runtime)).toMatchObject({
      schema: "asana-cli.worktree-bind.v1",
      alias_created: false,
      active: { task_gid: "1200000000002", status: "resolved" },
    });
    const history = await runContextCommand(parseArgs([
      "context", "history",
    ]), runtime) as Readonly<{ worktree_revision: number }>;
    expect(history).toMatchObject({
      schema: "asana-cli.context-history.v1",
      recent: [{ qualified_alias: alias }],
    });
    expect(await runContextCommand(parseArgs([
      "context", "clear", "--revision", String(history.worktree_revision),
    ]), runtime)).toMatchObject({
      schema: "asana-cli.context-clear.v1",
      cleared: true,
    });
    expect(await runContextCommand(parseArgs([
      "context", "bind",
      "task:platform/dev-017--worktree-task",
      "--task", "1200000000003",
    ]), runtime)).toMatchObject({
      schema: "asana-cli.worktree-bind.v1",
      alias_created: true,
      active: { task_gid: "1200000000003" },
    });
    expect(await runContextCommand(parseArgs([
      "context", "deactivate", "task:platform/dev-017--worktree-task",
    ]), runtime)).toMatchObject({
      schema: "asana-cli.worktree-deactivate.v1",
      deactivated: true,
    });
  });

  test("validates exact grammar before reading Git identity or local state", async () => {
    const store = new FileContextStateStore({ baseDirectory: await temporaryDirectory() });
    let identityReads = 0;
    const runtime = {
      store,
      identity: async () => {
        identityReads += 1;
        return identity;
      },
    };

    const cases = [
      ["context", "alias", "list", "extra"],
      ["context", "alias", "set", "task:platform/dev-014--bad", "--task"],
      ["context", "alias", "replace", "task:platform/dev-014--bad", "--task", "1"],
      ["context", "quick", "--unknown"],
      ["context", "bind", "task:platform/dev-017--worktree-task"],
      ["context", "deactivate"],
      ["context", "clear"],
      ["context", "history", "--compact", "--compact"],
    ];
    for (const args of cases) {
      expect((await capturedError(() =>
        runContextCommand(parseArgs(args), runtime)
      )).code).toBe("usage");
    }
    expect(identityReads).toBe(0);

    for (const args of [
      ["context", "alias", "set", "not-qualified", "--task", "1200000000001"],
      [
        "context", "alias", "set",
        "task:platform/dev-014--invalid-gid",
        "--task", "not-a-gid",
      ],
      ["context", "activate", "task:NOT-CANONICAL/dev-014--invalid"],
    ]) {
      expect((await capturedError(() =>
        runContextCommand(parseArgs(args), runtime)
      )).code).toBe("validation");
    }
    expect(identityReads).toBe(0);
  });

  test("denies inspection and mutation in agent mode", async () => {
    const listDenied = await capturedError(() =>
      runCli(["context", "alias", "list", "--agent"])
    );
    expect(listDenied).toMatchObject({
      code: "policy-denied",
      message: "Agent mode cannot inspect or mutate human alias and worktree context state",
    });
    const mutationDenied = await capturedError(() =>
      runCli([
        "context",
        "alias",
        "set",
        "task:platform/dev-014--agent-denied",
        "--task",
        "1200000000001",
        "--agent",
      ])
    );
    expect(mutationDenied).toMatchObject({ code: "policy-denied" });
    expect(await capturedError(() =>
      runCli([
        "context",
        "bind",
        "task:platform/dev-017--agent-denied",
        "--task",
        "1200000000001",
        "--agent",
      ])
    )).toMatchObject({ code: "policy-denied" });
  });

  test("executes before PAT resolution in the compiled-style entrypoint", async () => {
    const stateHome = await temporaryDirectory();
    const environment: Record<string, string | undefined> = {
      ...process.env,
      HOME: stateHome,
      XDG_STATE_HOME: stateHome,
    };
    delete environment.ASANA_ACCESS_TOKEN;
    delete environment.ASANA_PAT;

    const child = Bun.spawn([
      process.execPath,
      "run",
      "--no-env-file",
      "src/index.ts",
      "context",
      "alias",
      "list",
      "--compact",
    ], {
      cwd: projectRoot,
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      schema: "asana-cli.context-alias-list.v1",
      revision: 0,
      aliases: [],
    });
  });
});
