import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  array,
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

describe.skipIf(!existsSync(binary))("black-box public workflows", () => {
  test("executes human write previews and input materialization without network access", async () => {
    const fixture = await createFixture("asana-cli-black-box-dry-run-");
    const fakePat = "BLACK_BOX_DRY_RUN_PAT_129873";
    const environment = { ASANA_ACCESS_TOKEN: fakePat };
    try {
      const updatePath = join(fixture.project, "update.json");
      await writeFile(updatePath, JSON.stringify({
        data: {
          name: "Black-box rename",
          completed: false,
        },
      }));
      const update = record(await successfulJson(
        fixture,
        [
          "task",
          "update",
          "https://app.asana.com/0/100/1200000000001",
          "--data",
          "@update.json",
          "--dry-run",
          "--compact",
        ],
        { env: environment },
      ), "task update preview");
      expect(update).toEqual({
        dry_run: true,
        operation: "TasksApi.updateTask",
        task_gid: "1200000000001",
        body: {
          data: {
            name: "Black-box rename",
            completed: false,
          },
        },
      });

      const comment = record(await successfulJson(
        fixture,
        [
          "task",
          "comment",
          "1200000000001",
          "--stdin",
          "--dry-run",
          "--compact",
        ],
        {
          env: environment,
          stdin: "black-box comment\n",
        },
      ), "task comment preview");
      expect(comment).toEqual({
        dry_run: true,
        operation: "StoriesApi.createStoryForTask",
        task_gid: "1200000000001",
        body: { data: { text: "black-box comment\n" } },
      });

      const invalid = await runBinary(
        fixture,
        [
          "task",
          "update",
          "1200000000001",
          "--due-on",
          "2026-07-24",
          "--due-at",
          "2026-07-24T12:00:00Z",
          "--dry-run",
        ],
        { env: environment },
      );
      expect(invalid).toMatchObject({ exitCode: 2, stdout: "", timedOut: false });
      expect(wireError(decodeJson(invalid.stderr, "conflicting due date")).code).toBe(
        "validation",
      );

      for (const serialized of [JSON.stringify(update), JSON.stringify(comment), invalid.stderr]) {
        expect(serialized).not.toContain(fakePat);
      }
    } finally {
      await removeFixture(fixture);
    }
  });

  test("reads normalized Git and fixed-root repository context only through the binary", async () => {
    const fixture = await createFixture("asana-cli-black-box-repository-");
    try {
      git(fixture, fixture.project, ["init", "--quiet", "--initial-branch", "main"]);
      await writeFile(join(fixture.project, "README.md"), "black-box fixture\n");
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
        "remote",
        "add",
        "origin",
        "git@github.com:example/black-box-fixture.git",
      ]);

      const gitEnvelope = record(
        await successfulJson(fixture, ["agent", "context", "--git-current"]),
        "Git context envelope",
      );
      const gitResult = record(gitEnvelope.result, "Git context result");
      expect(gitResult).toMatchObject({
        operation: "git.context.current",
        effect: "read",
        policy: "read",
      });
      expect(record(gitResult.data, "Git context data")).toMatchObject({
        remote: { host: "github.com" },
        repository: { owner: "example", name: "black-box-fixture" },
        branch: "main",
      });
      expect(JSON.stringify(gitEnvelope)).not.toContain(fixture.root);
      expect(JSON.stringify(gitEnvelope)).not.toContain("git@github.com");

      const contextDirectory = join(fixture.project, ".asana-cli");
      await mkdir(contextDirectory);
      await writeFile(
        join(contextDirectory, "repository-context.json"),
        JSON.stringify({
          schema: "asana-cli.repository-context.v1",
          revision: 7,
          workspace_gid: "100",
          mappings: [
            {
              kind: "project",
              alias: "platform",
              project_gid: "200",
            },
            {
              kind: "task",
              project_alias: "platform",
              alias: "dev-019--black-box",
              task_gid: "300",
            },
          ],
        }),
      );

      const contextEnvelope = record(
        await successfulJson(
          fixture,
          ["agent", "context", "--repository-context"],
        ),
        "repository context envelope",
      );
      const contextData = record(
        record(contextEnvelope.result, "repository context result").data,
        "repository context data",
      );
      expect(contextData).toMatchObject({
        schema: "asana-cli.repository-context.v1",
        revision: 7,
        workspace_gid: "100",
      });
      const tasks = array(contextData.tasks, "repository context tasks");
      expect(tasks).toContainEqual({
        project_alias: "platform",
        alias: "dev-019--black-box",
        qualified_alias: "task:platform/dev-019--black-box",
        task_gid: "300",
      });
      expect(JSON.stringify(contextEnvelope)).not.toContain(fixture.root);
      expect(JSON.stringify(contextEnvelope)).not.toContain("repository-context.json");

      const missingOperation = await runBinary(fixture, [
        "agent",
        "operation",
        "status",
        "00000000-0000-4000-8000-000000000019",
      ]);
      expect(missingOperation).toMatchObject({
        exitCode: 4,
        stdout: "",
        timedOut: false,
      });
      expect(wireError(
        decodeJson(missingOperation.stderr, "missing operation"),
      ).code).toBe("not-found");
    } finally {
      await removeFixture(fixture);
    }
  });
});
