import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { runAgentCommand } from "../src/agent-cli";
import {
  readApplyAgentInput,
  readDirectAgentInput,
  readPrepareCommentAgentInput,
} from "../src/agent-input";
import { parseArgs } from "../src/args";
import { CliError } from "../src/errors";
import { MemoryOperationRepository } from "../src/operations/memory-repository";
import { createClient } from "../src/sdk";

const agentRuntime = { operations: new MemoryOperationRepository() };

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

async function errorCode(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
    return "none";
  } catch (error) {
    return z.instanceof(CliError).parse(error).code;
  }
}

describe("agent direct read input", () => {
  test("flags and compatible stdin reach the same Zod semantic source", async () => {
    const flags = await readDirectAgentInput(parseArgs([
      "agent",
      "my-tasks",
      "--workspace",
      "1200",
      "--completed",
      "all",
      "--limit",
      "20",
      "--paginate",
      "--max-results",
      "40",
    ]), "my-tasks");
    const stdin = await withAgentStdin({
      workspace_gid: "1200",
      completed: "all",
      limit: 20,
      paginate: true,
      max_results: 40,
    }, () => readDirectAgentInput(
      parseArgs(["agent", "my-tasks", "--input", "-"]),
      "my-tasks",
    ));
    expect(flags).toEqual(stdin);
  });

  test("accepts repeated include selectors and bounded content bytes", async () => {
    expect(await readDirectAgentInput(parseArgs([
      "agent",
      "get-task",
      "--task",
      "1201",
    ]), "get-task")).toEqual({
      task_gid: "1201",
      include: [],
      max_content_bytes: 16_384,
    });
    expect(await readDirectAgentInput(parseArgs([
      "agent",
      "get-task",
      "--task",
      "1201",
      "--include",
      "notes",
      "--include",
      "custom_fields",
      "--max-content-bytes",
      "12000",
    ]), "get-task")).toEqual({
      task_gid: "1201",
      include: ["notes", "custom_fields"],
      max_content_bytes: 12_000,
    });
  });

  test("maps every remaining canonical read flag set", async () => {
    expect(await readDirectAgentInput(parseArgs([
      "agent",
      "list-comments",
      "--task",
      "1201",
      "--limit",
      "10",
      "--no-paginate",
      "--max-results",
      "25",
      "--max-content-bytes",
      "2048",
    ]), "list-comments")).toEqual({
      task_gid: "1201",
      limit: 10,
      paginate: false,
      max_results: 25,
      max_content_bytes: 2048,
    });
    expect(await readDirectAgentInput(parseArgs([
      "agent",
      "search-tasks",
      "--query",
      "repo#1",
      "--workspace",
      "1200",
      "--all-assignees",
      "--no-completed",
      "--max-results",
      "30",
    ]), "search-tasks")).toEqual({
      query: "repo#1",
      workspace_gid: "1200",
      all_assignees: true,
      completed: false,
      max_results: 30,
    });
    expect(await readDirectAgentInput(parseArgs([
      "agent",
      "find-git",
      "--query",
      "PR-418",
      "--field",
      "999",
      "--contains",
      "--max-results",
      "300",
    ]), "find-git")).toEqual({
      query: "PR-418",
      all_assignees: false,
      max_results: 300,
      field_gid: "999",
      contains: true,
    });
  });

  test("fails closed on unknown, repeated scalar, mixed, and positional input", async () => {
    const invocations = [
      parseArgs(["agent", "my-tasks", "--fields", "notes"]),
      parseArgs(["agent", "my-tasks", "--limit", "1", "--limit", "2"]),
      parseArgs(["agent", "my-tasks", "--input", "-", "--max-results", "2"]),
      parseArgs(["agent", "my-tasks", "unexpected"]),
    ];
    for (const invocation of invocations) {
      expect(await errorCode(() => readDirectAgentInput(invocation, "my-tasks"))).toBe("usage");
    }
  });

  test("classifies syntactic flag errors as usage and semantic values as validation", async () => {
    expect(await errorCode(() => readDirectAgentInput(
      parseArgs(["agent", "get-task", "--task"]),
      "get-task",
    ))).toBe("usage");
    expect(await errorCode(() => readDirectAgentInput(
      parseArgs(["agent", "get-task", "--task", "not-a-gid"]),
      "get-task",
    ))).toBe("validation");
    expect(await errorCode(() => readDirectAgentInput(
      parseArgs(["agent", "list-comments", "--task", "123", "--max-content-bytes", "65537"]),
      "list-comments",
    ))).toBe("validation");
    expect(await errorCode(() => readDirectAgentInput(
      parseArgs(["agent", "list-comments", "--task", "123", "--max-content-bytes="]),
      "list-comments",
    ))).toBe("validation");
    expect(await errorCode(() => readDirectAgentInput(
      parseArgs(["agent", "get-task", "--task", "123", "--include", "unknown"]),
      "get-task",
    ))).toBe("validation");
  });

  test("rejects invalid direct input before any API request can start", async () => {
    const client = createClient("VALIDATION_BEFORE_NETWORK_TOKEN");
    client.basePath = "http://127.0.0.1:1/api/1.0";
    expect(await errorCode(() => runAgentCommand(client, parseArgs([
      "agent",
      "list-comments",
      "--task",
      "invalid",
    ]), agentRuntime))).toBe("validation");
    expect(await errorCode(() => runAgentCommand(client, parseArgs([
      "agent",
      "find-git",
      "--query",
      "PR-1",
      "--unknown",
    ]), agentRuntime))).toBe("usage");
  });

  test("status supports direct invocation and the compatible empty stdin object", async () => {
    expect(await readDirectAgentInput(
      parseArgs(["agent", "status"]),
      "status",
    )).toEqual({});
    expect(await withAgentStdin({}, () => readDirectAgentInput(
      parseArgs(["agent", "status", "--input", "-"]),
      "status",
    ))).toEqual({});
  });
});

describe("agent durable write input", () => {
  test("maps canonical prepare/apply flags and compatible stdin into the same Zod inputs", async () => {
    const operationId = "00000000-0000-4000-8000-000000000001";
    expect(await readApplyAgentInput(parseArgs([
      "agent",
      "apply",
      "--operation-id",
      operationId,
    ]))).toEqual(await withAgentStdin(
      { operation_id: operationId },
      () => readApplyAgentInput(parseArgs(["agent", "apply", "--input", "-"])),
    ));
    expect(await readPrepareCommentAgentInput(parseArgs([
      "agent",
      "prepare-comment",
      "--task",
      "123",
      "--text",
      "Comment",
    ]))).toEqual(await withAgentStdin(
      { task_gid: "123", text: "Comment" },
      () => readPrepareCommentAgentInput(parseArgs([
        "agent",
        "prepare-comment",
        "--input",
        "-",
      ])),
    ));
  });

  test("fails closed when operation ID flags conflict with stdin", async () => {
    expect(await errorCode(() => readApplyAgentInput(parseArgs([
      "agent",
      "apply",
      "--operation-id",
      "00000000-0000-4000-8000-000000000001",
      "--input",
      "-",
    ])))).toBe("usage");
  });
});
