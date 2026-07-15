import { describe, expect, test } from "bun:test";
import { AGENT_PROTOCOL_VERSION } from "../src/version";
import {
  OPERATION_FILE_FORMAT_VERSION,
  cloneOperationRecord,
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
  });
});
