import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runAgentCommand, runLocalAgentCommand } from "../src/agent-cli";
import { parseArgs } from "../src/args";
import { runCli } from "../src/cli";
import { CliError, normalizeError } from "../src/errors";
import { FileOperationRepository } from "../src/operations/file-repository";
import { MemoryOperationRepository } from "../src/operations/memory-repository";
import { operationLockPath, operationRecordPath, resolveOperationJournalDirectory } from "../src/operations/paths";
import { operationStatusProjectionSchema } from "../src/operations/status-projection";
import type {
  OperationCompareAndSetResult,
  OperationRepository,
} from "../src/operations/repository";
import type {
  CreateOperationInput,
  OperationRecord,
  OperationTransition,
} from "../src/operations/schemas";
import { createClient, type AsanaClient } from "../src/sdk";

const operationId = "00000000-0000-4000-8000-000000000401";
const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asana-operation-status-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function caughtCliError(action: () => Promise<unknown>): Promise<CliError> {
  try {
    await action();
  } catch (error) {
    return normalizeError(error);
  }
  throw new Error("Expected action to fail");
}

async function runEntrypoint(
  args: readonly string[],
  environment: Record<string, string | undefined>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env = Object.fromEntries(Object.entries({ ...process.env, ...environment }).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  ));
  const child = Bun.spawn([process.execPath, "run", "--no-env-file", "src/index.ts", ...args], {
    cwd: `${import.meta.dir}/..`,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

class InspectCountingRepository implements OperationRepository {
  readonly delegate: OperationRepository;
  inspectCalls = 0;

  constructor(delegate: OperationRepository) {
    this.delegate = delegate;
  }

  create(input: CreateOperationInput): Promise<OperationRecord> {
    return this.delegate.create(input);
  }

  get(id: string): Promise<OperationRecord | null> {
    return this.delegate.get(id);
  }

  async inspect(id: string): Promise<OperationRecord | null> {
    this.inspectCalls += 1;
    return this.delegate.inspect(id);
  }

  compareAndSet(transition: OperationTransition): Promise<OperationCompareAndSetResult> {
    return this.delegate.compareAndSet(transition);
  }
}

function clientThatMustStayLocal(): { client: AsanaClient; calls: number[] } {
  const client = createClient("AP010_LOCAL_ONLY_TOKEN");
  const calls: number[] = [];
  Object.defineProperty(client, "callApi", {
    configurable: true,
    value: async () => {
      calls.push(1);
      throw new Error("Operation status must not contact Asana");
    },
  });
  return { client, calls };
}

describe("agent operation status", () => {
  test("projects a persisted expired record locally without payload leakage or journal mutation", async () => {
    const baseDirectory = await temporaryDirectory();
    const repository = new FileOperationRepository({
      baseDirectory,
      clock: () => new Date("2020-01-01T00:00:00.000Z"),
      idGenerator: () => operationId,
    });
    await repository.create({
      operation: "task.comment",
      target: { task_gid: "123" },
      payload: { text: "AP010_STATUS_PAYLOAD_CANARY" },
      guards: {
        expected_modified_at: "2020-01-01T00:00:00.000Z",
        prepared_by_gid: "999",
      },
      ttl_ms: 1,
    });
    await repository.compareAndSet({
      id: operationId,
      expected_state: "prepared",
      next_state: "expired",
    });
    const recordPath = operationRecordPath(baseDirectory, operationId);
    const lockPath = operationLockPath(baseDirectory, operationId);
    await writeFile(lockPath, JSON.stringify({
      file_format_version: 1,
      operation_id: operationId,
      lock_id: "00000000-0000-4000-8000-000000000402",
      pid: 999_999,
      created_at: "2020-01-01T00:00:00.000Z",
    }), { mode: 0o600 });
    const before = await readFile(recordPath, "utf8");
    const localClient = clientThatMustStayLocal();

    const result = z.looseObject({
      operation: z.literal("operation.status"),
      effect: z.literal("read"),
      data: operationStatusProjectionSchema,
    }).parse(await runAgentCommand(
      localClient.client,
      parseArgs(["agent", "operation", "status", operationId]),
      { operations: repository },
    ));

    expect(result.data).toEqual({
      operation_id: operationId,
      operation: "task.comment",
      state: "expired",
      target: { task_gid: "123" },
      created_at: "2020-01-01T00:00:00.000Z",
      expires_at: "2020-01-01T00:00:00.001Z",
      is_expired: true,
      result: { outcome: "expired", recorded_at: "2020-01-01T00:00:00.000Z" },
      next_step: "prepare-a-new-operation",
    });
    expect(JSON.stringify(result)).not.toContain("AP010_STATUS_PAYLOAD_CANARY");
    expect(JSON.stringify(result)).not.toContain("prepared_by_gid");
    expect(localClient.calls).toEqual([]);
    expect(await readFile(recordPath, "utf8")).toBe(before);
    expect(await readdir(baseDirectory)).toContain(`${operationId}.lock`);
    expect((await repository.inspect(operationId))?.state).toBe("expired");
  });

  test("requires exactly the nested operation status grammar before inspecting local storage", async () => {
    const repository = new InspectCountingRepository(new MemoryOperationRepository());
    const malformedCases = [
      ["agent", "operation", "status"],
      ["agent", "operation", "recover", operationId],
      ["agent", "operation", "status", operationId, "unexpected"],
      ["agent", "operation", "status", operationId, "--force"],
    ];

    for (const argv of malformedCases) {
      const error = await caughtCliError(() => runLocalAgentCommand(parseArgs(argv), {
        operations: repository,
      }));
      expect(error.code).toBe("usage");
    }
    const invalidId = await caughtCliError(() => runLocalAgentCommand(parseArgs([
      "agent",
      "operation",
      "status",
      "not-a-uuid",
    ]), { operations: repository }));

    expect(invalidId.code).toBe("validation");
    expect(repository.inspectCalls).toBe(0);
  });

  test("runs as a local no-PAT command and reports an absent record without authentication", async () => {
    const originalAccessToken = process.env.ASANA_ACCESS_TOKEN;
    const originalPat = process.env.ASANA_PAT;
    delete process.env.ASANA_ACCESS_TOKEN;
    delete process.env.ASANA_PAT;
    try {
      const error = await caughtCliError(() => runCli([
        "agent",
        "operation",
        "status",
        "00000000-0000-4000-8000-000000000499",
      ]));
      expect(error.code).toBe("not-found");
    } finally {
      if (originalAccessToken === undefined) delete process.env.ASANA_ACCESS_TOKEN;
      else process.env.ASANA_ACCESS_TOKEN = originalAccessToken;
      if (originalPat === undefined) delete process.env.ASANA_PAT;
      else process.env.ASANA_PAT = originalPat;
    }
  });

  test("keeps direct persisted status schema-valid when credentials collide, while still rejecting disabled TLS", async () => {
    const home = await temporaryDirectory();
    const baseDirectory = resolveOperationJournalDirectory({ HOME: home, XDG_STATE_HOME: undefined });
    const repository = new FileOperationRepository({
      baseDirectory,
      clock: () => new Date("2020-01-01T00:00:00.000Z"),
      idGenerator: () => operationId,
    });
    await repository.create({
      operation: "task.comment",
      target: { task_gid: "123" },
      payload: { text: "AP010_ENTRYPOINT_STATUS_PAYLOAD_CANARY" },
      guards: {
        expected_modified_at: "2020-01-01T00:00:00.000Z",
        prepared_by_gid: "999",
      },
      ttl_ms: 1,
    });
    await repository.compareAndSet({
      id: operationId,
      expected_state: "prepared",
      next_state: "expired",
    });

    const credentialCollision = "expired";
    const args = ["agent", "operation", "status", operationId];
    const result = await runEntrypoint(args, {
      HOME: home,
      XDG_STATE_HOME: undefined,
      ASANA_PAT: credentialCollision,
      ASANA_ACCESS_TOKEN: credentialCollision,
      NODE_TLS_REJECT_UNAUTHORIZED: "",
    });
    const envelope = z.strictObject({
      schema: z.literal("asana-cli.agent.v2"),
      result: z.looseObject({
        operation: z.literal("operation.status"),
        effect: z.literal("read"),
        data: operationStatusProjectionSchema,
      }),
      _meta: z.looseObject({
        security: z.looseObject({ active_credential_redactions: z.literal(0) }),
      }),
      agent_protocol_version: z.number(),
      cli_version: z.string(),
      content_trust: z.literal("external-untrusted"),
    }).parse(JSON.parse(result.stdout));

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(envelope.result.data).toMatchObject({ state: "expired", is_expired: true });
    expect(JSON.stringify(envelope)).not.toContain("[REDACTED:KNOWN_SECRET]");

    const tlsRejected = await runEntrypoint(args, {
      HOME: home,
      XDG_STATE_HOME: undefined,
      ASANA_PAT: credentialCollision,
      ASANA_ACCESS_TOKEN: credentialCollision,
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    });
    const tlsError = z.looseObject({
      result: z.looseObject({
        error: z.looseObject({ code: z.literal("policy-denied"), message: z.string() }),
      }),
    }).parse(JSON.parse(tlsRejected.stderr));

    expect(tlsRejected.exitCode).toBe(2);
    expect(tlsRejected.stdout).toBe("");
    expect(tlsError.result.error.message).toContain("NODE_TLS_REJECT_UNAUTHORIZED=0");
  });
});
