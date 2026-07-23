import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { runAgentCommand } from "../src/agent-cli";
import { parseArgs } from "../src/args";
import { CliError } from "../src/errors";
import { MemoryOperationRepository } from "../src/operations/memory-repository";
import {
  repositoryContextDataSchema,
  type RepositoryContextManifestProvider,
} from "../src/repository-context";
import { createClient } from "../src/sdk";
import { parseTaskReference } from "../src/task-reference";

const baseRepositoryContext = repositoryContextDataSchema.parse({
  schema: "asana-cli.repository-context.v1",
  revision: 4,
  digest: `sha256:${"a".repeat(64)}`,
  workspace_gid: "1200",
  projects: [{ alias: "platform", project_gid: "2200" }],
  sections: [],
  custom_fields: [],
  tasks: [{
    project_alias: "platform",
    alias: "dev-013--exact-resolver",
    qualified_alias: "task:platform/dev-013--exact-resolver",
    task_gid: "3300",
  }],
});

function provider(
  value: z.output<typeof repositoryContextDataSchema> = baseRepositoryContext,
): RepositoryContextManifestProvider {
  return { load: async () => value };
}

async function cliError(action: () => Promise<unknown>): Promise<CliError> {
  try {
    await action();
    throw new Error("Expected failure");
  } catch (error: unknown) {
    return z.instanceof(CliError).parse(error);
  }
}

describe("central exact task reference resolver", () => {
  test("parses only canonical GID, v0/v1 URL, custom-ID, and qualified alias forms", () => {
    expect(parseTaskReference("gid:3300")).toMatchObject({
      kind: "gid",
      task_gid: "3300",
    });
    expect(parseTaskReference("url:https://app.asana.com/0/2200/3300")).toMatchObject({
      kind: "url-v0",
      project_gid: "2200",
      task_gid: "3300",
    });
    expect(parseTaskReference("url:https://app.asana.com/0/0/3300/f")).toMatchObject({
      kind: "url-v0",
      task_gid: "3300",
    });
    expect(parseTaskReference(
      "url:https://app.asana.com/1/1200/project/2200/task/3300",
    )).toMatchObject({
      kind: "url-v1",
      workspace_gid: "1200",
      project_gid: "2200",
      task_gid: "3300",
    });
    expect(parseTaskReference("url:https://app.asana.com/1/1200/task/3300"))
      .toMatchObject({
        kind: "url-v1",
        workspace_gid: "1200",
        task_gid: "3300",
      });
    expect(parseTaskReference("custom:1200/DEV13-42")).toMatchObject({
      kind: "custom-id",
      workspace_gid: "1200",
      custom_id: "DEV13-42",
    });
    expect(parseTaskReference("task:platform/dev-013--exact-resolver"))
      .toMatchObject({
        kind: "repository-alias",
        qualified_alias: "task:platform/dev-013--exact-resolver",
      });

    for (const invalid of [
      "3300",
      "DEV13-42",
      "https://app.asana.com/0/2200/3300",
      "url:http://app.asana.com/0/2200/3300",
      "url:https://evil.example/0/2200/3300",
      "url:https://app.asana.com/0/2200/3300?x=1",
      "url:https://APP.asana.com/0/2200/3300",
      "custom:1200/dev_13",
      "task:platform/Dev-013--exact-resolver",
      " gid:3300",
    ]) {
      expect(() => parseTaskReference(invalid)).toThrow();
    }
  });

  test("resolves every exact form to one live GID without returning task content", async () => {
    const requests: URL[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requests.push(url);
        if (url.pathname === "/api/1.0/workspaces/1200/tasks/custom_id/DEV13-42") {
          return Response.json({
            data: {
              gid: "3300",
              name: "DROP_CUSTOM_ENDPOINT_NAME",
              notes: "DROP_CUSTOM_ENDPOINT_NOTES",
            },
          });
        }
        if (url.pathname === "/api/1.0/tasks/3300") {
          return Response.json({
            data: {
              gid: "3300",
              name: "DROP_LIVE_NAME",
              notes: "DROP_LIVE_NOTES",
              workspace: { gid: "1200", name: "DROP_WORKSPACE_NAME" },
              memberships: [{
                project: { gid: "2200", name: "DROP_PROJECT_NAME" },
                section: { gid: "4400", name: "DROP_SECTION_NAME" },
              }],
            },
          });
        }
        return Response.json({ errors: [{ message: "missing" }] }, { status: 404 });
      },
    });

    try {
      const client = createClient("TASK_REFERENCE_TOKEN");
      client.basePath = new URL("/api/1.0", server.url).toString().replace(/\/$/, "");
      const runtime = {
        operations: new MemoryOperationRepository(),
        repositoryContext: provider(),
      };
      const references = [
        "gid:3300",
        "url:https://app.asana.com/0/2200/3300",
        "url:https://app.asana.com/1/1200/task/3300",
        "custom:1200/DEV13-42",
        "task:platform/dev-013--exact-resolver",
      ];
      for (const reference of references) {
        const result = await runAgentCommand(client, parseArgs([
          "agent",
          "resolve-task",
          "--reference",
          reference,
        ]), runtime);
        expect(result).toMatchObject({
          operation: "task.reference.resolve",
          data: {
            reference,
            task: { gid: "3300" },
            workspace_gid: "1200",
          },
        });
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain("DROP_");
        expect(serialized).not.toContain("notes");
      }
      const aliasResult = await runAgentCommand(client, parseArgs([
        "agent",
        "resolve-task",
        "--reference",
        "task:platform/dev-013--exact-resolver",
      ]), runtime);
      expect(aliasResult).toMatchObject({
        data: {
          project_gid: "2200",
          repository_context: {
            revision: 4,
            digest: `sha256:${"a".repeat(64)}`,
          },
        },
      });
      expect(requests.filter((url) => url.pathname.endsWith("/tasks/3300")))
        .toHaveLength(references.length + 1);
      expect(requests.every((url) => !url.searchParams.get("opt_fields")?.includes("notes")))
        .toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("reports absent, ambiguous, and stale aliases without selecting a target", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json({
          data: {
            gid: "3300",
            workspace: { gid: "1200" },
            memberships: [{ project: { gid: "9999" } }],
          },
        });
      },
    });
    try {
      const client = createClient("TASK_REFERENCE_FAILURE_TOKEN");
      client.basePath = new URL("/api/1.0", server.url).toString().replace(/\/$/, "");
      const operations = new MemoryOperationRepository();
      expect((await cliError(() => runAgentCommand(client, parseArgs([
        "agent", "resolve-task",
        "--reference", "task:platform/missing--task",
      ]), {
        operations,
        repositoryContext: provider(),
      }))).code).toBe("not-found");

      const ambiguous = {
        ...baseRepositoryContext,
        tasks: [
          ...baseRepositoryContext.tasks,
          { ...baseRepositoryContext.tasks[0]! },
        ],
      };
      expect((await cliError(() => runAgentCommand(client, parseArgs([
        "agent", "resolve-task",
        "--reference", "task:platform/dev-013--exact-resolver",
      ]), {
        operations,
        repositoryContext: provider(
          repositoryContextDataSchema.parse(ambiguous),
        ),
      }))).code).toBe("ambiguous");

      const stale = await cliError(() => runAgentCommand(client, parseArgs([
        "agent", "resolve-task",
        "--reference", "task:platform/dev-013--exact-resolver",
      ]), {
        operations,
        repositoryContext: provider(),
      }));
      expect(stale.code).toBe("stale");
      expect(stale.details).toEqual({ reason: "project-mismatch" });
    } finally {
      server.stop(true);
    }
  });
});
