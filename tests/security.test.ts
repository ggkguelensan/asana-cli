import { describe, expect, test } from "bun:test";
import {
  registerSecret,
  protectOutput,
} from "../src/security";

describe("deterministic credential protection", () => {
  test("redacts an exact registered credential at any depth", () => {
    const secret = "CANARY_secret.with.regex+[123]";
    registerSecret(secret);
    const result = protectOutput({ nested: [`Bearer ${secret}`, { value: secret }] });
    const serialized = JSON.stringify(result.value);
    expect(serialized).not.toContain(secret);
    expect(result.redactions).toBe(2);
  });

  test("redacts transport credential fields without serializing their values", () => {
    const result = protectOutput({ authorization: "anything", nested: { password: "anything" } });
    expect(result.value).toEqual({
      authorization: "[REDACTED:SENSITIVE_FIELD]",
      nested: { password: "[REDACTED:SENSITIVE_FIELD]" },
    });
  });

  test("does not pretend to detect unknown secrets heuristically", () => {
    const unknown = "unknown_secret_that_was_never_registered_0123456789";
    expect(protectOutput({ notes: unknown }).value).toEqual({ notes: unknown });
  });

  test("preserves repeated object references while still redacting real cycles", () => {
    const shared = { minimum: 2, maximum: 2 };
    expect(protectOutput({ first: shared, second: shared }).value).toEqual({
      first: shared,
      second: shared,
    });

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(protectOutput(circular).value).toEqual({
      self: "[REDACTED:CIRCULAR_REFERENCE]",
    });
  });

});
