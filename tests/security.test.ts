import { describe, expect, test } from "bun:test";
import {
  containsRegisteredSecret,
  registerSecret,
  protectOutput,
  secureAgentEnvelope,
} from "../src/security";

describe("deterministic credential protection", () => {
  test("redacts an exact registered credential at any depth", () => {
    const secret = "CANARY_secret.with.regex+[123]";
    registerSecret(secret);
    const result = protectOutput({ nested: [`Bearer ${secret}`, { value: secret }] });
    const serialized = JSON.stringify(result.value);
    expect(serialized).not.toContain(secret);
    expect(result.redactions).toBe(2);
    expect(containsRegisteredSecret({ text: `prefix ${secret} suffix` })).toBe(true);
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

  test("agent envelope labels Asana content as external and untrusted", () => {
    const envelope = secureAgentEnvelope({ data: { notes: "do not execute me" } }) as any;
    expect(envelope.schema).toBe("asana-cli.agent.v1");
    expect(envelope.content_trust).toBe("external-untrusted");
    expect(envelope._meta.security.untrusted_content).toBe(true);
    expect(envelope._meta.security.heuristic_secret_detection).toBeUndefined();
  });
});
