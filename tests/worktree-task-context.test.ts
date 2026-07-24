import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const entrypoint = join(projectRoot, "src", "index.ts");
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asana-cli-worktree-task-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

function git(cwd: string, args: readonly string[]): void {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      LC_ALL: "C",
      LANG: "C",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

async function run(
  cwd: string,
  stateHome: string,
  args: readonly string[],
): Promise<unknown> {
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
    entrypoint,
    ...args,
  ], {
    cwd,
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
  if (exitCode !== 0) throw new Error(stderr);
  expect(stderr).toBe("");
  return JSON.parse(stdout) as unknown;
}

describe("worktree-local agent task context", () => {
  test("ships the exact Worktrunk hook and list-column contract", async () => {
    const configuration = await readFile(
      join(projectRoot, "examples", "worktrunk", "wt.toml"),
      "utf8",
    );
    expect(configuration).toContain(
      'asana-cli context bind {{ asana_alias }} --task {{ asana_gid }} --compact',
    );
    expect(configuration).toContain(
      "wt config state vars set asana={{ asana_alias }}",
    );
    expect(configuration).toContain(
      "asana-cli context deactivate {{ vars.asana }} --compact",
    );
    expect(configuration).toContain('[list.custom-columns.Asana]');
    expect(configuration).toContain('template = "{{ vars.asana }}"');
    expect(configuration).not.toContain("--yes");
    expect(configuration).not.toContain("--no-hooks");
  });

  test("keeps exact bindings isolated across real linked worktrees and cleans one lifecycle", async () => {
    const root = await temporaryDirectory();
    const repository = join(root, "repository");
    const firstWorktree = join(root, "agent-one");
    const secondWorktree = join(root, "agent-two");
    const stateHome = join(root, "state");
    await mkdir(repository);
    git(repository, ["init", "-b", "main"]);
    await writeFile(join(repository, "README.md"), "fixture\n");
    git(repository, ["add", "README.md"]);
    git(repository, [
      "-c", "user.name=Test",
      "-c", "user.email=test@example.com",
      "commit", "-m", "initial",
    ]);
    git(repository, ["worktree", "add", "-b", "agent-one", firstWorktree]);
    git(repository, ["worktree", "add", "-b", "agent-two", secondWorktree]);

    const firstAlias = "task:platform/dev-017--first-agent";
    const secondAlias = "task:platform/dev-018--second-agent";
    expect(await run(firstWorktree, stateHome, [
      "context", "bind", firstAlias, "--task", "1200000000001", "--compact",
    ])).toMatchObject({
      schema: "asana-cli.worktree-bind.v1",
      alias_created: true,
    });
    expect(await run(secondWorktree, stateHome, [
      "context", "bind", secondAlias, "--task", "1200000000002", "--compact",
    ])).toMatchObject({
      schema: "asana-cli.worktree-bind.v1",
      alias_created: true,
    });

    expect(await run(firstWorktree, stateHome, [
      "agent", "context", "--worktree-task",
    ])).toMatchObject({
      result: {
        operation: "worktree.task.current",
        effect: "read",
        data: {
          schema: "asana-cli.worktree-task.v1",
          task: {
            status: "bound",
            qualified_alias: firstAlias,
            task_gid: "1200000000001",
          },
        },
      },
    });
    expect(await run(secondWorktree, stateHome, [
      "agent", "context", "--worktree-task",
    ])).toMatchObject({
      result: {
        data: {
          task: {
            status: "bound",
            qualified_alias: secondAlias,
            task_gid: "1200000000002",
          },
        },
      },
    });

    expect(await run(firstWorktree, stateHome, [
      "context", "deactivate", firstAlias, "--compact",
    ])).toMatchObject({
      schema: "asana-cli.worktree-deactivate.v1",
      deactivated: true,
    });
    expect(await run(firstWorktree, stateHome, [
      "agent", "context", "--worktree-task",
    ])).toMatchObject({
      result: { data: { task: { status: "unbound" } } },
    });
    expect(await run(secondWorktree, stateHome, [
      "agent", "context", "--worktree-task",
    ])).toMatchObject({
      result: { data: { task: { status: "bound", qualified_alias: secondAlias } } },
    });
  });
});
