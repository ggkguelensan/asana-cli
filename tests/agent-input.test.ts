import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { runAgentCommand } from "../src/agent-cli";
import {
  readApplyAgentInput,
  readDirectAgentInput,
  readGitCurrentCandidatesAgentInput,
  readPrepareCommentAgentInput,
  readRepositoryAsanaAgentInput,
  readRepositoryContextAgentInput,
  readStdinAgentInput,
  readTaskContextAgentInput,
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

  test("maps bounded project, membership, field, and user context flags", async () => {
    expect(await readDirectAgentInput(parseArgs([
      "agent", "list-projects",
      "--workspace", "1200",
      "--archived",
      "--limit", "20",
      "--paginate",
      "--max-results", "80",
    ]), "list-projects")).toEqual({
      workspace_gid: "1200",
      archived: true,
      limit: 20,
      paginate: true,
      max_results: 80,
    });
    expect(await readDirectAgentInput(parseArgs([
      "agent", "list-sections",
      "--project", "2200",
    ]), "list-sections")).toEqual({
      project_gid: "2200",
      limit: 50,
      paginate: false,
      max_results: 100,
    });
    expect(await readDirectAgentInput(parseArgs([
      "agent", "list-project-memberships",
      "--project", "2200",
      "--member", "3300",
    ]), "list-project-memberships")).toEqual({
      project_gid: "2200",
      member_gid: "3300",
      limit: 50,
      paginate: false,
      max_results: 100,
    });
    expect(await readDirectAgentInput(parseArgs([
      "agent", "list-custom-fields",
      "--workspace", "1200",
      "--max-results", "25",
    ]), "list-custom-fields")).toEqual({
      workspace_gid: "1200",
      limit: 50,
      paginate: false,
      max_results: 25,
    });
    expect(await readDirectAgentInput(parseArgs([
      "agent", "get-custom-field",
      "--field", "4400",
      "--include-values",
      "--max-content-bytes", "2048",
    ]), "get-custom-field")).toEqual({
      field_gid: "4400",
      include_values: true,
      max_content_bytes: 2048,
    });
    expect(await readDirectAgentInput(parseArgs([
      "agent", "resolve-user",
      "--workspace", "1200",
      "--user", "developer@example.com",
    ]), "resolve-user")).toEqual({
      workspace_gid: "1200",
      user: "developer@example.com",
    });
    expect(await readDirectAgentInput(parseArgs([
      "agent", "resolve-task",
      "--reference", "task:platform/dev-013--exact-resolver",
    ]), "resolve-task")).toEqual({
      reference: "task:platform/dev-013--exact-resolver",
    });

    const stdin = await withAgentStdin({
      project_gid: "2200",
      paginate: true,
      max_results: 40,
    }, () => readDirectAgentInput(
      parseArgs(["agent", "list-sections", "--input", "-"]),
      "list-sections",
    ));
    expect(stdin).toEqual({
      project_gid: "2200",
      limit: 50,
      paginate: true,
      max_results: 40,
    });
  });

  test("accepts only the bounded task-context grammar", () => {
    expect(readTaskContextAgentInput(parseArgs([
      "agent",
      "context",
      "--task",
      "1201",
      "--include",
      "notes",
      "--include",
      "field-values",
      "--max-related-results",
      "12",
      "--max-content-bytes",
      "4096",
    ]))).toEqual({
      task_gid: "1201",
      include: ["notes", "field-values"],
      max_related_results: 12,
      max_content_bytes: 4096,
    });

    const rejected = [
      ["agent", "context", "--task"],
      ["agent", "context", "--task", "not-a-gid"],
      ["agent", "context", "--task", "1201", "--include", "unknown"],
      ["agent", "context", "--task", "1201", "--max-related-results", "101"],
      ["agent", "context", "--task", "1201", "--workspace", "1200"],
      ["agent", "context", "--task", "1201", "--git-current-candidates"],
    ];
    for (const argv of rejected) {
      expect(() => readTaskContextAgentInput(parseArgs(argv))).toThrow();
    }
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
    expect(await errorCode(() => readDirectAgentInput(
      parseArgs([
        "agent", "get-custom-field",
        "--field", "4400",
        "--max-content-bytes", "1024",
      ]),
      "get-custom-field",
    ))).toBe("validation");
    expect(await errorCode(() => readDirectAgentInput(
      parseArgs([
        "agent", "resolve-user",
        "--workspace", "1200",
        "--user", "not-an-identifier",
      ]),
      "resolve-user",
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
    expect(await errorCode(() => runAgentCommand(client, parseArgs([
      "agent",
      "list-projects",
      "--workspace",
      "invalid",
    ]), agentRuntime))).toBe("validation");
  });

  test("accepts only the explicit workspace-scoped candidate grammar", async () => {
    expect(readGitCurrentCandidatesAgentInput(parseArgs([
      "agent",
      "context",
      "--git-current-candidates",
      "--workspace",
      "1200",
      "--all-assignees",
      "--no-completed",
      "--field",
      "900",
    ]))).toEqual({
      workspace_gid: "1200",
      all_assignees: true,
      completed: false,
      field_gid: "900",
    });

    const rejectedCases: Array<{ argv: string[]; code: "usage" | "validation" }> = [
      { argv: ["agent", "context", "--git-current-candidates"], code: "usage" },
      { argv: ["agent", "context", "--workspace", "1200"], code: "usage" },
      { argv: ["agent", "context", "--git-current-candidates", "--repository-asana"], code: "usage" },
      {
        argv: ["agent", "context", "--git-current-candidates", "--repository-asana", "--workspace", "1200"],
        code: "usage",
      },
      {
        argv: ["agent", "context", "--git-current-candidates", "--git-current", "--workspace", "1200"],
        code: "usage",
      },
      {
        argv: ["agent", "context", "--git-current-candidates", "--workspace", "1200", "--workspace", "1201"],
        code: "usage",
      },
      {
        argv: ["agent", "context", "--git-current-candidates", "--git-current-candidates", "--workspace", "1200"],
        code: "usage",
      },
      { argv: ["agent", "context", "--git-current-candidates", "--workspace", "1200", "--input", "-"], code: "usage" },
      { argv: ["agent", "context", "--git-current-candidates", "--workspace", "1200", "--query", "Acme/widgets"], code: "usage" },
      { argv: ["agent", "context", "--git-current-candidates", "--workspace", "1200", "--contains"], code: "usage" },
      { argv: ["agent", "context", "--git-current-candidates", "--workspace", "1200", "--max-results", "21"], code: "usage" },
      { argv: ["agent", "context", "--git-current-candidates", "--workspace", "1200", "--all-assignees", "sometimes"], code: "validation" },
      { argv: ["agent", "context", "--git-current-candidates", "--workspace", "not-a-gid"], code: "validation" },
    ];
    for (const { argv, code } of rejectedCases) {
      expect(await errorCode(async () => readGitCurrentCandidatesAgentInput(parseArgs(argv)))).toBe(code);
    }
  });

  test("accepts only the bare trusted repository mapping selector", async () => {
    expect(readRepositoryAsanaAgentInput(parseArgs([
      "agent",
      "context",
      "--repository-asana",
    ]))).toEqual({ repository_asana: true });

    const malformedInvocations = [
      ["agent", "context"],
      ["agent", "context", "--repository-asana=value"],
      ["agent", "context", "--repository-asana", "value"],
      ["agent", "context", "--repository-asana", "--repository-asana"],
      ["agent", "context", "--no-repository-asana"],
      ["agent", "context", "--repository-asana", "--input", "-"],
      ["agent", "context", "--repository-asana", "--git-current"],
      ["agent", "context", "--repository-asana", "--git-current-candidates", "--workspace", "1200"],
      ["agent", "context", "--repository-asana", "--workspace", "1200"],
    ];
    for (const argv of malformedInvocations) {
      expect(await errorCode(async () => readRepositoryAsanaAgentInput(parseArgs(argv)))).toBe("usage");
    }
  });

  test("accepts only the bare repository context selector", async () => {
    expect(readRepositoryContextAgentInput(parseArgs([
      "agent",
      "context",
      "--repository-context",
    ]))).toEqual({ repository_context: true });

    const malformedInvocations = [
      ["agent", "context"],
      ["agent", "context", "--repository-context=value"],
      ["agent", "context", "--repository-context", "value"],
      ["agent", "context", "--repository-context", "--repository-context"],
      ["agent", "context", "--no-repository-context"],
      ["agent", "context", "--repository-context", "--input", "-"],
      ["agent", "context", "--repository-context", "--git-current"],
      ["agent", "context", "--repository-context", "--repository-asana"],
      ["agent", "context", "--repository-context", "--workspace", "1200"],
    ];
    for (const argv of malformedInvocations) {
      expect(await errorCode(async () => readRepositoryContextAgentInput(parseArgs(argv)))).toBe("usage");
    }
  });

  test("rejects malformed candidate input before reading Git state or starting a request", async () => {
    const client = createClient("CANDIDATE_VALIDATION_BEFORE_NETWORK_TOKEN");
    client.basePath = "http://127.0.0.1:1/api/1.0";
    expect(await errorCode(() => runAgentCommand(client, parseArgs([
      "agent",
      "context",
      "--git-current-candidates",
      "--workspace",
      "invalid",
    ]), agentRuntime))).toBe("validation");
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

  test("batch tasks accepts only one strict stdin object", async () => {
    expect(await withAgentStdin(
      {
        task_gids: ["123", "124"],
        include: ["notes"],
        max_content_bytes: 1024,
      },
      () => readStdinAgentInput(
        parseArgs(["agent", "batch-tasks", "--input", "-"]),
        "batch-tasks",
      ),
    )).toEqual({
      task_gids: ["123", "124"],
      include: ["notes"],
      max_content_bytes: 1024,
    });
    expect(await errorCode(() => readStdinAgentInput(
      parseArgs(["agent", "batch-tasks", "--task", "123"]),
      "batch-tasks",
    ))).toBe("usage");
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
