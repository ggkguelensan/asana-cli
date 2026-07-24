import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  allFilesystemEntries,
  binary,
  createFixture,
  decodeJson,
  git,
  record,
  removeFixture,
  runBinary,
  successfulJson,
  wireError,
} from "./harness";

function agentData(envelope: unknown): Record<string, unknown> {
  return record(record(record(envelope, "agent envelope").result, "agent result").data, "agent data");
}

describe.skipIf(!existsSync(binary))("black-box linked-worktree isolation", () => {
  test("binds, isolates, conflicts, and cleans exact task context across real worktrees", async () => {
    const fixture = await createFixture("asana-cli-black-box-worktree-");
    const firstWorktree = join(fixture.root, "worktree-one");
    const secondWorktree = join(fixture.root, "worktree-two");
    const firstAlias = "task:platform/1201--alpha-task";
    const secondAlias = "task:platform/1202--beta-task";
    try {
      git(fixture, fixture.project, ["init", "--quiet", "--initial-branch", "main"]);
      await writeFile(join(fixture.project, "README.md"), "black-box worktrees\n");
      git(fixture, fixture.project, ["add", "README.md"]);
      git(fixture, fixture.project, [
        "-c",
        "user.name=Black Box",
        "-c",
        "user.email=black-box@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "initial",
      ]);
      git(fixture, fixture.project, [
        "worktree",
        "add",
        "--quiet",
        "-b",
        "agent-one",
        firstWorktree,
      ]);
      git(fixture, fixture.project, [
        "worktree",
        "add",
        "--quiet",
        "-b",
        "agent-two",
        secondWorktree,
      ]);

      const firstBinding = record(await successfulJson(
        fixture,
        [
          "context",
          "bind",
          firstAlias,
          "--task",
          "1200000000001",
          "--compact",
        ],
        { cwd: firstWorktree },
      ), "first binding");
      expect(firstBinding).toMatchObject({
        schema: "asana-cli.worktree-bind.v1",
        alias_created: true,
        active: {
          qualified_alias: firstAlias,
          task_gid: "1200000000001",
        },
      });

      const repeatedBinding = record(await successfulJson(
        fixture,
        [
          "context",
          "bind",
          firstAlias,
          "--task",
          "1200000000001",
          "--compact",
        ],
        { cwd: firstWorktree },
      ), "repeated binding");
      expect(repeatedBinding).toMatchObject({
        schema: "asana-cli.worktree-bind.v1",
        alias_created: false,
      });

      const retargetAttempt = await runBinary(
        fixture,
        [
          "context",
          "bind",
          firstAlias,
          "--task",
          "1200000000999",
          "--compact",
        ],
        { cwd: firstWorktree },
      );
      expect(retargetAttempt).toMatchObject({
        exitCode: 4,
        stdout: "",
        timedOut: false,
      });
      expect(wireError(
        decodeJson(retargetAttempt.stderr, "retarget conflict"),
      ).code).toBe("conflict");

      await successfulJson(
        fixture,
        [
          "context",
          "bind",
          secondAlias,
          "--task",
          "1200000000002",
          "--compact",
        ],
        { cwd: secondWorktree },
      );

      const firstProjection = await successfulJson(
        fixture,
        ["agent", "context", "--worktree-task"],
        { cwd: firstWorktree },
      );
      expect(agentData(firstProjection)).toMatchObject({
        schema: "asana-cli.worktree-task.v1",
        task: {
          status: "bound",
          qualified_alias: firstAlias,
          task_gid: "1200000000001",
        },
      });
      const secondProjection = await successfulJson(
        fixture,
        ["agent", "context", "--worktree-task"],
        { cwd: secondWorktree },
      );
      expect(agentData(secondProjection)).toMatchObject({
        task: {
          status: "bound",
          qualified_alias: secondAlias,
          task_gid: "1200000000002",
        },
      });
      for (const projection of [firstProjection, secondProjection]) {
        const serialized = JSON.stringify(projection);
        expect(serialized).not.toContain(fixture.root);
        expect(serialized).not.toContain("agent-one");
        expect(serialized).not.toContain("agent-two");
        expect(serialized).not.toContain("git@");
      }

      const staleCleanup = await runBinary(
        fixture,
        ["context", "deactivate", secondAlias, "--compact"],
        { cwd: firstWorktree },
      );
      expect(staleCleanup).toMatchObject({
        exitCode: 4,
        stdout: "",
        timedOut: false,
      });
      expect(wireError(
        decodeJson(staleCleanup.stderr, "stale cleanup"),
      ).code).toBe("conflict");
      expect(agentData(await successfulJson(
        fixture,
        ["agent", "context", "--worktree-task"],
        { cwd: firstWorktree },
      ))).toMatchObject({
        task: { status: "bound", qualified_alias: firstAlias },
      });

      const cleanup = record(await successfulJson(
        fixture,
        ["context", "deactivate", firstAlias, "--compact"],
        { cwd: firstWorktree },
      ), "worktree cleanup");
      expect(cleanup).toMatchObject({
        schema: "asana-cli.worktree-deactivate.v1",
        deactivated: true,
      });
      expect(record(await successfulJson(
        fixture,
        ["context", "deactivate", firstAlias, "--compact"],
        { cwd: firstWorktree },
      ), "idempotent worktree cleanup").deactivated).toBe(false);
      expect(agentData(await successfulJson(
        fixture,
        ["agent", "context", "--worktree-task"],
        { cwd: firstWorktree },
      ))).toMatchObject({ task: { status: "unbound" } });
      expect(agentData(await successfulJson(
        fixture,
        ["agent", "context", "--worktree-task"],
        { cwd: secondWorktree },
      ))).toMatchObject({
        task: { status: "bound", qualified_alias: secondAlias },
      });

      const entries = [
        ...await allFilesystemEntries(fixture.state),
        ...await allFilesystemEntries(fixture.home),
      ];
      expect(entries.length).toBeGreaterThan(0);
      for (const path of entries) {
        const stats = await lstat(path);
        expect(stats.mode & 0o077).toBe(0);
        if (stats.isFile()) {
          const contents = await readFile(path, "utf8");
          expect(contents).not.toContain(fixture.root);
          expect(contents).not.toContain("agent-one");
          expect(contents).not.toContain("agent-two");
          expect(contents).not.toContain("BLACK_BOX");
        }
      }
    } finally {
      await removeFixture(fixture);
    }
  }, 30_000);
});
