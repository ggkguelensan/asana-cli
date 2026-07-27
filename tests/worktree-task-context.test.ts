import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runGitSync } from "./support/git";
import { runSourceCli } from "./support/process";
import { TemporaryDirectories } from "./support/temp";

const projectRoot = resolve(import.meta.dir, "..");
const temporaryDirectories = new TemporaryDirectories();

afterEach(async () => {
  await temporaryDirectories.cleanup();
});

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
    const root = await temporaryDirectories.create("asana-cli-worktree-task-");
    const repository = join(root, "repository");
    const firstWorktree = join(root, "agent-one");
    const secondWorktree = join(root, "agent-two");
    const stateHome = join(root, "state");
    await mkdir(repository);
    runGitSync(repository, ["init", "-b", "main"]);
    await writeFile(join(repository, "README.md"), "fixture\n");
    runGitSync(repository, ["add", "README.md"]);
    runGitSync(repository, [
      "-c", "user.name=Test",
      "-c", "user.email=test@example.com",
      "commit", "-m", "initial",
    ]);
    runGitSync(repository, ["worktree", "add", "-b", "agent-one", firstWorktree]);
    runGitSync(repository, ["worktree", "add", "-b", "agent-two", secondWorktree]);

    const firstAlias = "task:platform/dev-017--first-agent";
    const secondAlias = "task:platform/dev-018--second-agent";
    const run = async (cwd: string, args: readonly string[]): Promise<unknown> => {
      const result = await runSourceCli(args, {
        cwd,
        env: {
          HOME: stateHome,
          XDG_STATE_HOME: stateHome,
          ASANA_ACCESS_TOKEN: undefined,
          ASANA_PAT: undefined,
        },
      });
      if (result.exitCode !== 0) throw new Error(result.stderr);
      expect(result.stderr).toBe("");
      return JSON.parse(result.stdout) as unknown;
    };
    expect(await run(firstWorktree, [
      "context", "bind", firstAlias, "--task", "1200000000001", "--compact",
    ])).toMatchObject({
      schema: "asana-cli.worktree-bind.v1",
      alias_created: true,
    });
    expect(await run(secondWorktree, [
      "context", "bind", secondAlias, "--task", "1200000000002", "--compact",
    ])).toMatchObject({
      schema: "asana-cli.worktree-bind.v1",
      alias_created: true,
    });

    expect(await run(firstWorktree, [
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
    expect(await run(secondWorktree, [
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

    expect(await run(firstWorktree, [
      "context", "deactivate", firstAlias, "--compact",
    ])).toMatchObject({
      schema: "asana-cli.worktree-deactivate.v1",
      deactivated: true,
    });
    expect(await run(firstWorktree, [
      "agent", "context", "--worktree-task",
    ])).toMatchObject({
      result: { data: { task: { status: "unbound" } } },
    });
    expect(await run(secondWorktree, [
      "agent", "context", "--worktree-task",
    ])).toMatchObject({
      result: { data: { task: { status: "bound", qualified_alias: secondAlias } } },
    });
  });
});
