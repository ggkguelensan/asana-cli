import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { batchTasksInputSchema, MAX_BATCH_TASKS } from "../src/agent-action-schemas";
import { runAgentCommand } from "../src/agent-cli";
import { parseArgs } from "../src/args";
import { batchReadTasks } from "../src/batch-tasks";
import { MemoryOperationRepository } from "../src/operations/memory-repository";
import { createClient, type AsanaClient } from "../src/sdk";

const apiCallSchema = z.tuple([
  z.string(),
  z.string(),
  z.record(z.string(), z.string()),
  z.record(z.string(), z.unknown()),
  z.record(z.string(), z.unknown()),
  z.record(z.string(), z.unknown()),
  z.unknown(),
  z.array(z.string()),
  z.array(z.string()),
  z.array(z.string()),
  z.unknown(),
]);

function batchClient(results: readonly unknown[]): {
  client: AsanaClient;
  calls: Array<{ path: string; method: string; body: unknown }>;
} {
  const client = createClient(`BATCH_TASKS_${Math.random().toString(16).slice(2)}`);
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  Object.defineProperty(client, "callApi", {
    configurable: true,
    value: async (...rawArguments: unknown[]) => {
      const [path, method, , , , , body] = apiCallSchema.parse(rawArguments);
      calls.push({ path, method, body });
      if (path !== "/batch" || method !== "POST") {
        throw new Error(`Unexpected fake Asana call: ${method} ${path}`);
      }
      return {
        response: {},
        data: { data: [...results], next_page: null },
      };
    },
  });
  return { client, calls };
}

async function withAgentStdin<Result>(
  input: unknown,
  action: () => Promise<Result>,
): Promise<Result> {
  const runtime = Bun as unknown as { stdin: { text(): Promise<string> } };
  const original = runtime.stdin;
  runtime.stdin = { text: async () => JSON.stringify(input) };
  try {
    return await action();
  } finally {
    runtime.stdin = original;
  }
}

describe("bounded task batch reads", () => {
  test("uses one fixed GET-only batch and one shared UTF-8 content budget", async () => {
    const asana = batchClient([
      {
        status_code: 200,
        body: {
          data: {
            gid: "123",
            name: "Alpha",
            completed: false,
            notes: "First note",
            assignee: { gid: "1001", name: "Developer" },
            projects: [{ gid: "200", name: "Platform" }],
            memberships: [{ project: { gid: "200", name: "Platform" } }],
          },
        },
      },
      {
        status_code: 200,
        body: {
          data: {
            gid: "124",
            name: "Beta",
            completed: true,
            notes: "Second note",
          },
        },
      },
    ]);
    const result = await batchReadTasks(asana.client, {
      task_gids: ["123", "124"],
      include: ["notes"],
      max_content_bytes: 8,
    });

    expect(result).toMatchObject({
      schema: "asana-cli.task-batch.v1",
      results: [
        {
          task_gid: "123",
          outcome: "success",
          task: { gid: "123", name: "Alpha", notes: "" },
        },
        {
          task_gid: "124",
          outcome: "success",
          task: { gid: "124", name: "", notes: "" },
        },
      ],
      content_profile: "selected-untrusted",
      content_budget: {
        max_bytes: 8,
        emitted_bytes: 8,
        truncated: true,
      },
      meta: {
        requested: 2,
        succeeded: 2,
        failed: 0,
        partial: false,
        request_budget: {
          max_actions: 10,
          used_actions: 2,
          transport_requests: 1,
        },
        result_budget: { max_results: 10, emitted_results: 2 },
      },
    });
    expect(asana.calls).toHaveLength(1);
    expect(asana.calls[0]).toMatchObject({ path: "/batch", method: "POST" });
    const actions = z.strictObject({
      data: z.strictObject({
        actions: z.array(z.strictObject({
          method: z.literal("GET"),
          relative_path: z.string(),
        })),
      }),
    }).parse(asana.calls[0]?.body).data.actions;
    expect(actions).toHaveLength(2);
    expect(actions.map((action) => action.relative_path.split("?")[0])).toEqual([
      "/tasks/123",
      "/tasks/124",
    ]);
    for (const action of actions) {
      const fields = new URL(`https://batch.invalid${action.relative_path}`)
        .searchParams.get("opt_fields");
      expect(fields).toContain("gid");
      expect(fields).toContain("notes");
      expect(fields).not.toContain("html_notes");
    }
  });

  test("returns ordered bounded per-item failures without serializing response bodies", async () => {
    const asana = batchClient([
      {
        status_code: 200,
        body: { data: { gid: "123", name: "Available" } },
      },
      {
        status_code: 404,
        body: {
          errors: [{
            message: "BATCH_RAW_ERROR_SECRET must not cross the projection",
          }],
        },
      },
      {
        status_code: 200,
        body: { data: { gid: "999", name: "Wrong identity" } },
      },
    ]);
    const result = await batchReadTasks(asana.client, {
      task_gids: ["123", "124", "125"],
      include: [],
      max_content_bytes: 100,
    });

    expect(result.results).toEqual([
      expect.objectContaining({ task_gid: "123", outcome: "success" }),
      {
        task_gid: "124",
        outcome: "error",
        error: { code: "not-found", status_code: 404 },
      },
      {
        task_gid: "125",
        outcome: "error",
        error: { code: "invalid-response" },
      },
    ]);
    expect(result.meta).toMatchObject({
      requested: 3,
      succeeded: 1,
      failed: 2,
      partial: true,
    });
    expect(JSON.stringify(result)).not.toContain("BATCH_RAW_ERROR_SECRET");
    expect(JSON.stringify(result)).not.toContain("Wrong identity");
  });

  test("reports nested projection truncation instead of silently dropping results", async () => {
    const projects = Array.from({ length: 101 }, (_, index) => ({
      gid: String(10_000 + index),
      name: `Project ${index}`,
    }));
    const asana = batchClient([{
      status_code: 200,
      body: { data: { gid: "123", projects } },
    }]);
    const result = await batchReadTasks(asana.client, {
      task_gids: ["123"],
      include: [],
      max_content_bytes: 0,
    });
    if (result.results[0]?.outcome !== "success") {
      throw new Error("Expected a successful bounded projection");
    }
    expect(result.results[0].task.projects).toHaveLength(100);
    expect(result.results[0]).toMatchObject({
      task_gid: "123",
      outcome: "success",
      projection: {
        truncated: true,
        truncated_fields: ["projects"],
      },
    });
  });

  test("rejects duplicate or oversized request sets and mismatched response counts", async () => {
    expect(batchTasksInputSchema.safeParse({
      task_gids: ["123", "123"],
    }).success).toBe(false);
    expect(batchTasksInputSchema.safeParse({
      task_gids: Array.from({ length: MAX_BATCH_TASKS + 1 }, (_, index) => String(index + 1)),
    }).success).toBe(false);

    const asana = batchClient([]);
    await expect(batchReadTasks(asana.client, {
      task_gids: ["123"],
      include: [],
      max_content_bytes: 100,
    })).rejects.toMatchObject({ code: "internal" });
  });

  test("routes the stdin-only action through the secure agent envelope", async () => {
    const asana = batchClient([{
      status_code: 200,
      body: { data: { gid: "123", name: "One task" } },
    }]);
    const envelope = await withAgentStdin(
      { task_gids: ["123"] },
      () => runAgentCommand(
        asana.client,
        parseArgs(["agent", "batch-tasks", "--input", "-"]),
        { operations: new MemoryOperationRepository() },
      ),
    );
    expect(envelope).toMatchObject({
      operation: "tasks.batch.get",
      effect: "read",
      data: {
        schema: "asana-cli.task-batch.v1",
        results: [{ task_gid: "123", outcome: "success" }],
      },
    });
  });
});
