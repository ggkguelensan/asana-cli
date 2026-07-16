import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AgentOperationService } from "../src/agent-operations";
import { FileMetadataAuditStore } from "../src/audit/file-repository";
import type { MetadataAuditStore } from "../src/audit/repository";
import {
  createMetadataAuditEvent,
  metadataAuditEventSchema,
  type CreateMetadataAuditEventInput,
  type MetadataAuditEvent,
} from "../src/audit/schemas";
import { CliError, normalizeError } from "../src/errors";
import {
  FixedFileHostScopedWritePolicyProvider,
  fixedHostScopedWritePolicyPath,
  type HostScopedWritePolicyProvider,
  type WindowsPolicyCommandResult,
} from "../src/host-write-policy";
import { MemoryOperationRepository } from "../src/operations/memory-repository";
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
import {
  describeTaskCommentWrite,
  describeTaskUpdateWrite,
  evaluateScopedWritePolicy,
  type ScopedWritePolicy,
  type ScopedWritePolicyDecision,
} from "../src/write-policy";

const operationId = "00000000-0000-4000-8000-000000000501";
const auditEventId = "00000000-0000-4000-8000-000000000502";
const preparedAt = "2026-07-15T10:00:00.000Z";
const modifiedAt = "2026-07-15T09:00:00.000Z";
const directories: string[] = [];

const permittedPolicy: ScopedWritePolicy = {
  schema: "asana-cli.scoped-write-policy.v1",
  scopes: [{
    workspace_gid: "100",
    project_gids: ["200"],
    task_update_fields: ["name", "custom_fields"],
    custom_field_gids: ["300"],
    allow_comments: true,
  }],
};

const textEncoder = new TextEncoder();

function windowsPolicyResult(
  stdout: string,
  options: Readonly<Partial<Pick<WindowsPolicyCommandResult, "stderr" | "exitCode">>> = {},
): WindowsPolicyCommandResult {
  return {
    stdout: textEncoder.encode(stdout),
    stderr: options.stderr ?? new Uint8Array(),
    exitCode: options.exitCode ?? 0,
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asana-wave5-security-"));
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

type ApiTrace = Readonly<{ method: string; path: string; body: unknown }>;

function scopedFakeAsana(options: { failRemoteWrite?: boolean } = {}): { client: AsanaClient; traces: ApiTrace[] } {
  const client = createClient("SEC005_AUDIT_TOKEN_CANARY");
  const traces: ApiTrace[] = [];
  Object.defineProperty(client, "callApi", {
    configurable: true,
    value: async (...argumentsValue: unknown[]) => {
      const path = z.string().parse(argumentsValue[0]);
      const method = z.string().parse(argumentsValue[1]);
      const body = argumentsValue[6];
      traces.push({ method, path, body });
      if (method === "GET" && path === "/users/{user_gid}") {
        return { response: {}, data: { data: { gid: "1001", name: "Owner" } } };
      }
      if (method === "GET" && path === "/tasks/{task_gid}") {
        return {
          response: {},
          data: {
            data: {
              gid: "123",
              name: "Policy-target task",
              modified_at: modifiedAt,
              assignee: { gid: "1001", name: "Owner" },
              workspace: { gid: "100" },
              memberships: [{ project: { gid: "200" } }],
            },
          },
        };
      }
      if (method === "POST") {
        if (options.failRemoteWrite) throw new Error("SEC005_REMOTE_WRITE_FAILURE_CANARY");
        return { response: {}, data: { data: { gid: "9001", type: "comment" } } };
      }
      if (method === "PUT") {
        return {
          response: {},
          data: { data: { gid: "123", modified_at: "2026-07-15T10:01:00.000Z" } },
        };
      }
      throw new Error(`Unexpected fake Asana call: ${method} ${path}`);
    },
  });
  return { client, traces };
}

function memoryRepository(): MemoryOperationRepository {
  return new MemoryOperationRepository({
    clock: () => new Date(preparedAt),
    idGenerator: () => operationId,
  });
}

function policyProvider(policy: ScopedWritePolicy): HostScopedWritePolicyProvider {
  return { load: async () => policy };
}

function commentInput(): Extract<CreateOperationInput, { operation: "task.comment" }> {
  return {
    operation: "task.comment",
    target: { task_gid: "123" },
    payload: { text: "SEC005_COMMENT_PAYLOAD_CANARY" },
    guards: { expected_modified_at: modifiedAt, prepared_by_gid: "1001" },
    ttl_ms: 60_000,
  };
}

class FailingAppliedOperationRepository implements OperationRepository {
  readonly delegate: OperationRepository;

  constructor(delegate: OperationRepository) {
    this.delegate = delegate;
  }

  create(input: CreateOperationInput): Promise<OperationRecord> {
    return this.delegate.create(input);
  }

  get(id: string): Promise<OperationRecord | null> {
    return this.delegate.get(id);
  }

  inspect(id: string): Promise<OperationRecord | null> {
    return this.delegate.inspect(id);
  }

  async compareAndSet(transition: OperationTransition): Promise<OperationCompareAndSetResult> {
    if (transition.next_state === "applied") throw new Error("SEC005_APPLIED_STORAGE_FAILURE_CANARY");
    return this.delegate.compareAndSet(transition);
  }
}

describe("host scoped write policy", () => {
  test("allows only the configured workspace, project, write fields, custom fields, and comments", () => {
    const target = { workspace_gid: "100", project_gids: ["200"] };
    const cases: ReadonlyArray<Readonly<{
      candidate: unknown;
      expected: ScopedWritePolicyDecision;
      policy?: ScopedWritePolicy;
    }>> = [
      {
        candidate: describeTaskUpdateWrite(target, { name: "Allowed rename" }),
        expected: { allowed: true },
      },
      {
        candidate: describeTaskUpdateWrite(target, { custom_fields: { "300": "Allowed value" } }),
        expected: { allowed: true },
      },
      {
        candidate: describeTaskCommentWrite(target),
        expected: { allowed: true },
      },
      {
        candidate: describeTaskCommentWrite({ workspace_gid: "101", project_gids: ["200"] }),
        expected: { allowed: false, reason: "workspace_not_allowed" },
      },
      {
        candidate: describeTaskCommentWrite({ workspace_gid: "100", project_gids: ["201"] }),
        expected: { allowed: false, reason: "project_not_allowed" },
      },
      {
        candidate: describeTaskUpdateWrite(target, { completed: true }),
        expected: { allowed: false, reason: "write_field_not_allowed" },
      },
      {
        candidate: describeTaskUpdateWrite(target, { custom_fields: { "301": "Not allowed" } }),
        expected: { allowed: false, reason: "custom_field_not_allowed" },
      },
      {
        candidate: describeTaskCommentWrite(target),
        policy: {
          ...permittedPolicy,
          scopes: [{ ...permittedPolicy.scopes[0]!, allow_comments: false }],
        },
        expected: { allowed: false, reason: "comments_not_allowed" },
      },
    ];

    for (const testCase of cases) {
      expect(evaluateScopedWritePolicy(testCase.policy ?? permittedPolicy, testCase.candidate)).toEqual(
        testCase.expected,
      );
    }
  });

  test("uses canonical Darwin and Linux host policy locations", () => {
    const cases = [
      { platform: "darwin" as const, expected: "/private/etc/asana-cli/scoped-write-policy.json" },
      { platform: "linux" as const, expected: "/etc/asana-cli/scoped-write-policy.json" },
    ];

    for (const testCase of cases) {
      expect(fixedHostScopedWritePolicyPath(testCase.platform)).toBe(testCase.expected);
    }
  });

  test("loads canonical Windows policy output through one frozen fixed-path PowerShell command", async () => {
    const callerSuppliedPath = "C:\\untrusted\\caller-supplied-policy.json";
    const canonicalPayload = Buffer.from(JSON.stringify(permittedPolicy)).toString("base64");
    let receivedCommand: readonly string[] | undefined;
    const provider = new FixedFileHostScopedWritePolicyProvider({
      platform: "win32",
      path: callerSuppliedPath,
      windowsCommandRunner: async (command) => {
        receivedCommand = command;
        return windowsPolicyResult(canonicalPayload);
      },
    });

    await expect(provider.load()).resolves.toEqual(permittedPolicy);
    expect(provider.path).toBe("C:\\ProgramData\\asana-cli\\scoped-write-policy.json");
    expect(fixedHostScopedWritePolicyPath("win32")).toBe(provider.path);
    expect(receivedCommand).toBeDefined();
    expect(Object.isFrozen(receivedCommand)).toBe(true);
    expect(receivedCommand).toHaveLength(6);
    expect(receivedCommand?.slice(0, 5)).toEqual([
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
    ]);
    expect(receivedCommand?.[5]).toContain("$policyPath = 'C:\\ProgramData\\asana-cli\\scoped-write-policy.json'");
    expect(receivedCommand?.join("\n")).not.toContain(callerSuppliedPath);
    expect(receivedCommand?.join("\n")).not.toContain(canonicalPayload);
  });

  test("fails closed for rejected Windows inspector statuses and untrusted payloads", async () => {
    const canonicalPayload = Buffer.from(JSON.stringify(permittedPolicy)).toString("base64");
    const cases: ReadonlyArray<Readonly<{
      name: string;
      result: WindowsPolicyCommandResult;
    }>> = [
      {
        name: "nonzero inspector status",
        result: windowsPolicyResult(canonicalPayload, { exitCode: 1 }),
      },
      {
        name: "inspector standard error",
        result: windowsPolicyResult(canonicalPayload, { stderr: textEncoder.encode("inspector failure") }),
      },
      {
        name: "malformed base64 payload",
        result: windowsPolicyResult("not-base64!"),
      },
      {
        name: "noncanonical base64 payload",
        result: windowsPolicyResult(Buffer.from("{}").toString("base64").replace(/=$/, "")),
      },
      {
        name: "oversize policy payload",
        result: windowsPolicyResult(Buffer.from(`${" ".repeat(49_153)}${JSON.stringify(permittedPolicy)}`).toString("base64")),
      },
      {
        name: "invalid policy content",
        result: windowsPolicyResult(Buffer.from("{}").toString("base64")),
      },
    ];

    for (const testCase of cases) {
      const repository = memoryRepository();
      const asana = scopedFakeAsana();
      const error = await caughtCliError(() => new AgentOperationService(asana.client, repository, {
        writePolicy: new FixedFileHostScopedWritePolicyProvider({
          platform: "win32",
          windowsCommandRunner: async () => testCase.result,
        }),
      }).prepareComment({ task_gid: "123", text: "Blocked comment" }));

      expect(error.code).toBe("policy-denied");
      expect(await repository.inspect(operationId)).toBeNull();
      expect(asana.traces.filter((trace) => trace.method === "POST" || trace.method === "PUT")).toEqual([]);
    }
  });

  test("blocks preparation before persistence or remote mutation when the injected Windows loader fails", async () => {
    const repository = memoryRepository();
    const asana = scopedFakeAsana();
    const error = await caughtCliError(() => new AgentOperationService(asana.client, repository, {
      writePolicy: new FixedFileHostScopedWritePolicyProvider({
        platform: "win32",
        windowsCommandRunner: async () => {
          throw new Error("WINDOWS_POLICY_RUNNER_FAILURE_CANARY");
        },
      }),
    }).prepareComment({ task_gid: "123", text: "Blocked comment" }));

    expect(error.code).toBe("policy-denied");
    expect(JSON.stringify(error)).not.toContain("WINDOWS_POLICY_RUNNER_FAILURE_CANARY");
    expect(await repository.inspect(operationId)).toBeNull();
    expect(asana.traces.filter((trace) => trace.method === "POST" || trace.method === "PUT")).toEqual([]);
  });

  test("fails closed for malformed, unsafe, symlinked, outside-root, and legacy Darwin host policies without disclosure", async () => {
    const directory = await temporaryDirectory();
    const malformedPath = join(directory, "malformed-policy.json");
    const unsafePath = join(directory, "unsafe-policy.json");
    const symlinkPath = join(directory, "policy-link.json");
    const policyContents = "SEC005_HOST_POLICY_CONTENT_CANARY:not-json";
    await writeFile(malformedPath, policyContents, { mode: 0o600 });
    await writeFile(unsafePath, JSON.stringify(permittedPolicy), { mode: 0o600 });
    await chmod(unsafePath, 0o666);
    await symlink(malformedPath, symlinkPath);

    const cases = [
      { name: "malformed temporary policy outside the trusted root", path: malformedPath },
      { name: "group-writable temporary policy outside the trusted root", path: unsafePath },
      { name: "symlinked temporary policy outside the trusted root", path: symlinkPath },
      {
        name: "legacy Linux policy location on Darwin",
        path: "/etc/asana-cli/scoped-write-policy.json",
        platform: "darwin" as const,
      },
    ];

    for (const testCase of cases) {
      const repository = memoryRepository();
      const asana = scopedFakeAsana();
      const error = await caughtCliError(() => new AgentOperationService(asana.client, repository, {
        writePolicy: new FixedFileHostScopedWritePolicyProvider(testCase),
      }).prepareComment({ task_gid: "123", text: "Blocked comment" }));

      expect(error.code).toBe("policy-denied");
      expect(error.message).toBe("The host write policy does not permit this task operation");
      expect(JSON.stringify(error)).not.toContain(testCase.path);
      expect(JSON.stringify(error)).not.toContain(policyContents);
      expect(await repository.inspect(operationId)).toBeNull();
      expect(asana.traces.filter((trace) => trace.method === "POST" || trace.method === "PUT")).toEqual([]);
    }
  });

  test("rechecks policy at apply and blocks a policy-revoked operation before CAS or remote write", async () => {
    const repository = memoryRepository();
    const asana = scopedFakeAsana();
    let loads = 0;
    const revokedPolicy: ScopedWritePolicy = {
      ...permittedPolicy,
      scopes: [{ ...permittedPolicy.scopes[0]!, allow_comments: false }],
    };
    const changingPolicy: HostScopedWritePolicyProvider = {
      load: async () => {
        loads += 1;
        return loads === 1 ? permittedPolicy : revokedPolicy;
      },
    };
    const service = new AgentOperationService(asana.client, repository, { writePolicy: changingPolicy });
    await service.prepareComment({ task_gid: "123", text: "Policy-rechecked comment" });

    const error = await caughtCliError(() => service.apply(operationId));
    expect(error.code).toBe("policy-denied");
    expect(JSON.stringify(error)).not.toContain("100");
    expect(JSON.stringify(error)).not.toContain("200");
    expect(loads).toBe(2);
    expect((await repository.inspect(operationId))?.state).toBe("prepared");
    expect(asana.traces.filter((trace) => trace.method === "POST" || trace.method === "PUT")).toEqual([]);
  });

  test("does not treat a matching repository mapping as write authorization at prepare or apply", async () => {
    const repository = memoryRepository();
    const asana = scopedFakeAsana();
    const hostDeniedOptions = {
      writePolicy: policyProvider({
        schema: "asana-cli.scoped-write-policy.v1",
        scopes: [],
      }),
      repositoryAsanaMapping: {
        find: async () => ({
          remote: { host: "github.example" },
          repository: { owner: "Acme", name: "widgets" },
          workspace_gid: "100",
          project_gid: "200",
          git_reference_custom_field_gid: "300",
        }),
      },
    };
    const service = new AgentOperationService(asana.client, repository, hostDeniedOptions);

    const prepareError = await caughtCliError(() => service.prepareComment({
      task_gid: "123",
      text: "Mapping cannot authorize this comment",
    }));
    const prepared = await repository.create(commentInput());
    const applyError = await caughtCliError(() => service.apply(prepared.id));

    expect(prepareError.code).toBe("policy-denied");
    expect(applyError.code).toBe("policy-denied");
    expect((await repository.inspect(prepared.id))?.state).toBe("prepared");
    expect(asana.traces.filter((trace) => trace.method === "POST" || trace.method === "PUT")).toEqual([]);
  });

  test("does not treat repository context task aliases as write authority at prepare or apply", async () => {
    const repository = memoryRepository();
    const asana = scopedFakeAsana();
    const hostDeniedOptions = {
      writePolicy: policyProvider({
        schema: "asana-cli.scoped-write-policy.v1",
        scopes: [],
      }),
      repositoryContext: {
        load: async () => ({
          schema: "asana-cli.repository-context.v1" as const,
          revision: 7,
          digest: `sha256:${"a".repeat(64)}`,
          workspace_gid: "100",
          projects: [{ alias: "platform", project_gid: "200" }],
          sections: [],
          custom_fields: [],
          tasks: [{
            project_alias: "platform",
            alias: "dev-012--repository-context",
            qualified_alias: "task:platform/dev-012--repository-context",
            task_gid: "123",
          }],
        }),
      },
    };
    const service = new AgentOperationService(asana.client, repository, hostDeniedOptions);

    const prepareError = await caughtCliError(() => service.prepareComment({
      task_gid: "123",
      text: "Repository context cannot authorize this comment",
    }));
    const prepared = await repository.create(commentInput());
    const applyError = await caughtCliError(() => service.apply(prepared.id));

    expect(prepareError.code).toBe("policy-denied");
    expect(applyError.code).toBe("policy-denied");
    expect((await repository.inspect(prepared.id))?.state).toBe("prepared");
    expect(asana.traces.filter((trace) => trace.method === "POST" || trace.method === "PUT")).toEqual([]);
  });
});

describe("metadata-only operation audit", () => {
  test("persists the stable metadata-only audit event format", async () => {
    const baseDirectory = await temporaryDirectory();
    const store = new FileMetadataAuditStore({
      baseDirectory,
      clock: () => new Date(preparedAt),
      eventIdGenerator: () => auditEventId,
    });
    const input: CreateMetadataAuditEventInput = {
      operation_id: operationId,
      target_task_gid: "123",
      action: "task.comment",
      plan_hash: `sha256:${"a".repeat(64)}`,
      record_hash: `sha256:${"b".repeat(64)}`,
      result: { outcome: "prepared" },
    };
    const event = await store.append(input);
    const files = await readdir(baseDirectory);
    const stored = metadataAuditEventSchema.parse(JSON.parse(await readFile(
      join(baseDirectory, files[0]!),
      "utf8",
    )));

    expect(stored).toEqual(event);
    expect(event).toEqual({
      schema: "asana-cli.audit-event.v1",
      file_format_version: 1,
      event_id: auditEventId,
      occurred_at: preparedAt,
      ...input,
    });
    expect(metadataAuditEventSchema.safeParse({
      ...event,
      comment_text: "SEC005_FORBIDDEN_AUDIT_CONTENT_CANARY",
    }).success).toBe(false);
  });

  test("records prepared, applying, and applied lifecycle metadata without content or credential disclosure", async () => {
    const events: CreateMetadataAuditEventInput[] = [];
    const audit: MetadataAuditStore = {
      append: async (event) => {
        events.push(structuredClone(event));
        return createMetadataAuditEvent(
          event,
          new Date(preparedAt),
          `00000000-0000-4000-8000-00000000050${events.length}`,
        );
      },
    };
    const repository = memoryRepository();
    const asana = scopedFakeAsana();
    const service = new AgentOperationService(asana.client, repository, {
      writePolicy: policyProvider(permittedPolicy),
      audit,
    });

    await service.prepareComment({ task_gid: "123", text: "SEC005_COMMENT_PAYLOAD_CANARY" });
    await service.apply(operationId);

    expect(events.map((event) => event.result.outcome)).toEqual(["prepared", "applying", "applied"]);
    expect(events.every((event) => event.target_task_gid === "123" && event.action === "task.comment")).toBe(true);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("SEC005_COMMENT_PAYLOAD_CANARY");
    expect(serialized).not.toContain("SEC005_AUDIT_TOKEN_CANARY");
  });

  test("rolls a failed applying audit claim back to a retryable pristine record before the remote write", async () => {
    const repository = memoryRepository();
    await repository.create(commentInput());
    const asana = scopedFakeAsana();
    const events: CreateMetadataAuditEventInput[] = [];
    let failApplyingAudit = true;
    const audit: MetadataAuditStore = {
      append: async (event) => {
        if (event.result.outcome === "applying" && failApplyingAudit) {
          throw new Error("SEC005_AUDIT_STORAGE_FAILURE_CANARY");
        }
        events.push(structuredClone(event));
        return createMetadataAuditEvent(event, new Date(preparedAt), auditEventId);
      },
    };
    const service = new AgentOperationService(asana.client, repository, {
      writePolicy: policyProvider(permittedPolicy),
      audit,
    });

    const firstError = await caughtCliError(() => service.apply(operationId));
    const rolledBack = await repository.inspect(operationId);

    expect(firstError.code).toBe("storage-invalid");
    expect(JSON.stringify(firstError)).not.toContain("SEC005_AUDIT_STORAGE_FAILURE_CANARY");
    expect(rolledBack?.state).toBe("prepared");
    expect(rolledBack?.attempt_started_at).toBeUndefined();
    expect(rolledBack?.result).toBeUndefined();
    expect(asana.traces.filter((trace) => trace.method === "POST" || trace.method === "PUT")).toEqual([]);

    failApplyingAudit = false;
    const applied = await service.apply(operationId);

    expect(applied.state).toBe("applied");
    expect((await repository.inspect(operationId))?.state).toBe("applied");
    expect(events.map((event) => event.result.outcome)).toEqual(["applying", "applied"]);
    expect(asana.traces.filter((trace) => trace.method === "POST" || trace.method === "PUT")).toHaveLength(1);
  });

  test("marks an after-write persistence failure unknown and never repeats the remote operation", async () => {
    const baseRepository = memoryRepository();
    await baseRepository.create(commentInput());
    const repository = new FailingAppliedOperationRepository(baseRepository);
    const asana = scopedFakeAsana();
    const events: CreateMetadataAuditEventInput[] = [];
    const audit: MetadataAuditStore = {
      append: async (event) => {
        events.push(structuredClone(event));
        return createMetadataAuditEvent(event, new Date(preparedAt), auditEventId);
      },
    };
    const service = new AgentOperationService(asana.client, repository, {
      writePolicy: policyProvider(permittedPolicy),
      audit,
    });

    const firstError = await caughtCliError(() => service.apply(operationId));
    const secondError = await caughtCliError(() => service.apply(operationId));

    expect(firstError.code).toBe("unknown-result");
    expect(secondError.code).toBe("unknown-result");
    expect((await baseRepository.inspect(operationId))?.state).toBe("unknown");
    expect(events.map((event) => event.result.outcome)).toEqual(["applying", "unknown"]);
    expect(asana.traces.filter((trace) => trace.method === "POST")).toHaveLength(1);
  });

  test("marks a remote invocation failure unknown and never repeats its write", async () => {
    const repository = memoryRepository();
    await repository.create(commentInput());
    const asana = scopedFakeAsana({ failRemoteWrite: true });
    const events: CreateMetadataAuditEventInput[] = [];
    const audit: MetadataAuditStore = {
      append: async (event) => {
        events.push(structuredClone(event));
        return createMetadataAuditEvent(event, new Date(preparedAt), auditEventId);
      },
    };
    const service = new AgentOperationService(asana.client, repository, {
      writePolicy: policyProvider(permittedPolicy),
      audit,
    });

    const firstError = await caughtCliError(() => service.apply(operationId));
    const secondError = await caughtCliError(() => service.apply(operationId));
    const record = await repository.inspect(operationId);

    expect(firstError.code).toBe("unknown-result");
    expect(secondError.code).toBe("unknown-result");
    expect(record).toMatchObject({
      state: "unknown",
      result: { outcome: "unknown", request_may_have_succeeded: true },
    });
    expect(events.map((event) => event.result.outcome)).toEqual(["applying", "unknown"]);
    expect(asana.traces.filter((trace) => trace.method === "POST")).toHaveLength(1);
  });
});
