import { describe, expect, test } from "bun:test";
import { CLI_ERROR_REGISTRY, CliError, cliErrorCodeSchema, errorPayload, errorPayloadSchema, normalizeError } from "../src/errors";

describe("plain JSON error contract", () => {
  test("validates the error registry and serialized payload", () => {
    expect(Object.keys(CLI_ERROR_REGISTRY)).toEqual(cliErrorCodeSchema.options);
    const value = errorPayload(new CliError("usage", "Unknown command"));
    expect(errorPayloadSchema.parse(value)).toEqual({ error: { code: "usage", message: "Unknown command", exit_code: 2 } });
  });
  test("maps Asana HTTP failures without serializing SDK internals", () => {
    for (const [status, expected] of [[401, "auth-failed"], [403, "auth-failed"], [404, "not-found"], [409, "conflict"], [429, "asana-api"], [500, "asana-api"]] as const) {
      const error = normalizeError({ status, response: { body: { errors: [{ message: "Request failed" }] } }, request: { authorization: "hidden" } });
      expect(error.code).toBe(expected);
      expect(errorPayload(error).error.details).toMatchObject({ http_status: status });
      expect(JSON.stringify(errorPayload(error))).not.toContain("authorization");
    }
  });
  test("distinguishes transport errors from programming errors", () => {
    expect(normalizeError(new TypeError("fetch failed")).code).toBe("network");
    expect(normalizeError(new Error("bug")).code).toBe("internal");
  });
});
