import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { readDirectAgentInput } from "../src/agent-input";
import { parseArgs } from "../src/args";
import { CliError } from "../src/errors";

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
  });

  test("status has no input mode or action flags", async () => {
    expect(await readDirectAgentInput(
      parseArgs(["agent", "status"]),
      "status",
    )).toEqual({});
    expect(await errorCode(() => readDirectAgentInput(
      parseArgs(["agent", "status", "--input", "-"]),
      "status",
    ))).toBe("usage");
  });
});
