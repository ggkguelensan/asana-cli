import { describe, expect, test } from "bun:test";
import { AGENT_PROTOCOL_VERSION } from "../src/version";
import {
  OPERATION_FILE_FORMAT_VERSION,
  cloneOperationRecord,
  createOperationInputSchema,
  createOperationRecord,
  operationRecordFileSchema,
  parseOperationRecord,
  transitionOperationRecord,
} from "../src/operations/schemas";

const operationId = "00000000-0000-4000-8000-000000000001";
const createdAt = new Date("2026-07-15T10:00:00.000Z");

const guards = {
  expected_modified_at: "2026-07-15T09:00:00.000Z",
  prepared_by_gid: "123456",
} as const;

describe("operation record schemas", () => {
  test("creates a versioned task update record with stable integrity hashes", () => {
    const record = createOperationRecord({
      operation: "task.update",
      target: { task_gid: "987654" },
      payload: { changes: { name: "Release", completed: false } },
      guards,
      ttl_ms: 60_000,
    }, createdAt, operationId);

    expect(record).toMatchObject({
      schema: "asana-cli.operation.v1",
      file_format_version: OPERATION_FILE_FORMAT_VERSION,
      agent_protocol_version: AGENT_PROTOCOL_VERSION,
      id: operationId,
      operation: "task.update",
      state: "prepared",
      created_at: "2026-07-15T10:00:00.000Z",
      expires_at: "2026-07-15T10:01:00.000Z",
    });
    expect(record.plan_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(record.record_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(parseOperationRecord(cloneOperationRecord(record))).toEqual(record);
  });

  test("fails closed when immutable plan content is tampered", () => {
    const record = createOperationRecord({
      operation: "task.comment",
      target: { task_gid: "987654" },
      payload: { text: "approved comment" },
      guards,
      ttl_ms: 60_000,
    }, createdAt, operationId);
    const tampered = structuredClone(record);
    const payload = tampered.payload as { text: string };
    payload.text = "tampered comment";

    expect(() => parseOperationRecord(tampered)).toThrow("hash mismatch");
  });

  test("terminal result metadata cannot contain content, credentials, headers, HTTP bodies, or stacks", () => {
    const prepared = createOperationRecord({
      operation: "task.comment",
      target: { task_gid: "987654" },
      payload: { text: "approved comment" },
      guards,
      ttl_ms: 60_000,
    }, createdAt, operationId);
    const applying = transitionOperationRecord(prepared, {
      id: operationId,
      expected_state: "prepared",
      next_state: "applying",
    }, new Date("2026-07-15T10:00:10.000Z"));
    const applied = transitionOperationRecord(applying, {
      id: operationId,
      expected_state: "applying",
      next_state: "applied",
      metadata: { resource_gid: "555" },
    }, new Date("2026-07-15T10:00:20.000Z"));

    expect(applying.attempt_started_at).toBe("2026-07-15T10:00:10.000Z");
    expect(applied.attempt_started_at).toBe(applying.attempt_started_at);
    expect(applied.plan_hash).toBe(prepared.plan_hash);

    for (const forbidden of [
      { text: "task content" },
      { pat: "secret" },
      { headers: { authorization: "secret" } },
      { raw_http: { body: "response" } },
      { stack: "trace" },
    ]) {
      expect(operationRecordFileSchema.safeParse({
        ...applied,
        result: { ...applied.result, ...forbidden },
      }).success).toBe(false);
    }
  });

  test("represents ambiguous writes as terminal unknown metadata without retry semantics", () => {
    const prepared = createOperationRecord({
      operation: "task.update",
      target: { task_gid: "987654" },
      payload: { changes: { completed: true } },
      guards,
      ttl_ms: 60_000,
    }, createdAt, operationId);
    const applying = transitionOperationRecord(prepared, {
      id: operationId,
      expected_state: "prepared",
      next_state: "applying",
    }, createdAt);
    const unknown = transitionOperationRecord(applying, {
      id: operationId,
      expected_state: "applying",
      next_state: "unknown",
      metadata: { error_code: "NETWORK_OUTCOME_UNKNOWN" },
    }, createdAt);

    expect(unknown.result).toEqual({
      outcome: "unknown",
      recorded_at: createdAt.toISOString(),
      request_may_have_succeeded: true,
      error_code: "NETWORK_OUTCOME_UNKNOWN",
    });
    expect(unknown.attempt_started_at).toBe(createdAt.toISOString());
  });

  test("reuses the curated task patch schema for update operations", () => {
    const customFields = Object.fromEntries(
      Array.from({ length: 51 }, (_, index) => [String(10_000 + index), index]),
    );
    expect(() => createOperationRecord({
      operation: "task.update",
      target: { task_gid: "987654" },
      payload: { changes: { custom_fields: customFields } },
      guards,
      ttl_ms: 60_000,
    }, createdAt, operationId)).toThrow("Too many custom field updates");

    expect(() => createOperationInputSchema.parse({
      operation: "task.update",
      target: { task_gid: "987654" },
      payload: { changes: { arbitrary_api_field: true } },
      guards,
      ttl_ms: 60_000,
    })).toThrow();
  });

  test("requires complete immutable task-create targets, assignee, and subtask guards", () => {
    const task = createOperationRecord({
      operation: "task.create",
      target: { workspace_gid: "100", project_gid: "200" },
      payload: {
        fields: {
          name: "Create me",
          assignee_gid: "123456",
          custom_fields: { "300": "ready" },
        },
      },
      guards: { prepared_by_gid: "123456" },
      ttl_ms: 60_000,
    }, createdAt, operationId);
    expect(task).toMatchObject({
      operation: "task.create",
      target: { workspace_gid: "100", project_gid: "200" },
      payload: { fields: { assignee_gid: "123456" } },
    });

    expect(() => createOperationInputSchema.parse({
      operation: "task.create",
      target: {
        workspace_gid: "100",
        project_gid: "200",
        parent_task_gid: "987654",
      },
      payload: {
        fields: { name: "Missing parent guard", assignee_gid: "123456" },
      },
      guards: { prepared_by_gid: "123456" },
    })).toThrow("subtask creation requires an exact parent concurrency guard");

    expect(() => createOperationInputSchema.parse({
      operation: "task.create",
      target: { workspace_gid: "100", project_gid: "200" },
      payload: {
        fields: {
          name: "Invalid start date",
          assignee_gid: "123456",
          start_on: "2026-08-01",
        },
      },
      guards: { prepared_by_gid: "123456" },
    })).toThrow("task start_on requires due_on or due_at");
  });

  test("stores each project and section mutation as one strict immutable operation", () => {
    const base = {
      target: { task_gid: "987654" },
      guards,
      ttl_ms: 60_000,
    };
    const add = createOperationRecord({
      ...base,
      operation: "task.project.add",
      payload: { project_gid: "200", section_gid: "300" },
    }, createdAt, operationId);
    expect(add).toMatchObject({
      operation: "task.project.add",
      target: { task_gid: "987654" },
      payload: { project_gid: "200", section_gid: "300" },
    });
    expect(parseOperationRecord(add)).toEqual(add);

    expect(createOperationInputSchema.parse({
      ...base,
      operation: "task.project.remove",
      payload: { project_gid: "200" },
    })).toMatchObject({ operation: "task.project.remove" });
    expect(createOperationInputSchema.parse({
      ...base,
      operation: "task.section.move",
      payload: { project_gid: "200", section_gid: "300" },
    })).toMatchObject({ operation: "task.section.move" });
    expect(() => createOperationInputSchema.parse({
      ...base,
      operation: "task.section.move",
      payload: { project_gid: "200" },
    })).toThrow();
  });

  test("stores one exact dependency relation with guards for both tasks", () => {
    const dependencyGuards = {
      ...guards,
      expected_dependency_modified_at: "2026-07-15T08:30:00.000Z",
    };
    const add = createOperationRecord({
      operation: "task.dependency.add",
      target: { task_gid: "987654" },
      payload: { dependency_task_gid: "987655" },
      guards: dependencyGuards,
      ttl_ms: 60_000,
    }, createdAt, operationId);
    expect(parseOperationRecord(add)).toEqual(add);
    expect(add).toMatchObject({
      operation: "task.dependency.add",
      payload: { dependency_task_gid: "987655" },
      guards: dependencyGuards,
    });
    expect(createOperationInputSchema.parse({
      operation: "task.dependency.remove",
      target: { task_gid: "987654" },
      payload: { dependency_task_gid: "987655" },
      guards: dependencyGuards,
    })).toMatchObject({ operation: "task.dependency.remove" });
    expect(() => createOperationInputSchema.parse({
      operation: "task.dependency.add",
      target: { task_gid: "987654" },
      payload: { dependency_task_gid: "987654" },
      guards: dependencyGuards,
    })).toThrow("a task cannot depend on itself");
    expect(() => createOperationInputSchema.parse({
      operation: "task.dependency.remove",
      target: { task_gid: "987654" },
      payload: { dependency_task_gid: "987655" },
      guards,
    })).toThrow();
  });
});
