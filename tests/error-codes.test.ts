import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { assertPreparedTaskIsCurrent } from "../src/agent-cli";
import { runCli } from "../src/cli";
import {
  AGENT_ERROR_SCHEMA_ID,
  CLI_ERROR_REGISTRY,
  CliError,
  cliErrorCodeSchema,
  errorPayload,
  errorPayloadSchema,
  normalizeError,
} from "../src/errors";
import { resolvePatWithSource } from "../src/pat-store";
import { jsonObjectSchema } from "../src/schemas";
import { secureAgentEnvelope } from "../src/security";

async function rejectedCliError(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (error) {
    return normalizeError(error);
  }
  throw new Error("Expected promise to reject");
}

const wireErrorSchema = z.looseObject({
  result: errorPayloadSchema,
});

async function runAgentFailure(
  args: string[],
  options: { stdin?: string; env?: Record<string, string> } = {},
) {
  const child = Bun.spawn([process.execPath, "run", "--no-env-file", "src/index.ts", ...args], {
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env, ...options.env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (options.stdin !== undefined) child.stdin.write(options.stdin);
  child.stdin.end();
  const [stderr, exitCode] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const decoded: unknown = JSON.parse(stderr);
  return { exitCode, payload: wireErrorSchema.parse(decoded) };
}

describe("stable machine error codes", () => {
  test("publishes a closed Zod-validated registry", () => {
    expect(Object.keys(CLI_ERROR_REGISTRY)).toEqual(cliErrorCodeSchema.options);
    expect(CLI_ERROR_REGISTRY).toMatchObject({
      usage: { default_exit_code: 2 },
      validation: { default_exit_code: 2 },
      "auth-required": { default_exit_code: 3 },
      "auth-failed": { default_exit_code: 3 },
      "policy-denied": { default_exit_code: 2 },
      "not-found": { default_exit_code: 4 },
      conflict: { default_exit_code: 4 },
      stale: { default_exit_code: 4 },
      expired: { default_exit_code: 4 },
      "unknown-result": { default_exit_code: 4, retryable: false },
      "storage-locked": { default_exit_code: 4 },
      "storage-invalid": { default_exit_code: 3 },
      network: { default_exit_code: 1 },
      "asana-api": { default_exit_code: 4 },
      internal: { default_exit_code: 1 },
      interrupted: { default_exit_code: 130 },
    });
  });

  test("serializes code on every error payload", () => {
    for (const code of cliErrorCodeSchema.options) {
      const payload = errorPayloadSchema.parse(errorPayload(new CliError(code, "test")));
      expect(payload.error.code).toBe(code);
      expect(payload.error.exit_code).toBe(CLI_ERROR_REGISTRY[code].default_exit_code);
    }
  });

  test("distinguishes unknown action and invalid runtime input", async () => {
    const unknown = await rejectedCliError(runCli(["agent", "schema", "unknown-action"]));
    expect(unknown.code).toBe("usage");
    expect(unknown.exitCode).toBe(2);

    const unknownRuntime = await runAgentFailure(["agent", "unknown-action"], {
      env: { ASANA_ACCESS_TOKEN: "ERROR_CODE_ACTION_TEST", ASANA_CLI_AGENT_POLICY: "read" },
    });
    expect(unknownRuntime.exitCode).toBe(2);
    expect(unknownRuntime.payload.result.error.code).toBe("usage");

    const invalid = await runAgentFailure(["agent", "my-tasks", "--input", "-"], {
      stdin: '{"unexpected":true}',
      env: { ASANA_ACCESS_TOKEN: "ERROR_CODE_INPUT_TEST", ASANA_CLI_AGENT_POLICY: "read" },
    });
    expect(invalid.exitCode).toBe(2);
    expect(invalid.payload.result.error.code).toBe("validation");
  });

  test("distinguishes missing credentials and policy denial", async () => {
    const missing = await rejectedCliError(resolvePatWithSource({}, async () => null));
    expect(missing.code).toBe("auth-required");
    expect(missing.exitCode).toBe(3);

    const denied = await runAgentFailure(["agent", "apply-comment", "--input", "-"], {
      env: {
        ASANA_ACCESS_TOKEN: "ERROR_CODE_POLICY_TEST",
        ASANA_CLI_AGENT_POLICY: "read",
      },
    });
    expect(denied.exitCode).toBe(2);
    expect(denied.payload.result.error.code).toBe("policy-denied");
  });

  test("classifies optimistic task conflicts as stale", () => {
    expect(() => assertPreparedTaskIsCurrent("1", "new", "1", "old"))
      .toThrow(CliError);
    try {
      assertPreparedTaskIsCurrent("1", "new", "1", "old");
    } catch (error) {
      const normalized = normalizeError(error);
      expect(normalized.code).toBe("stale");
      expect(normalized.exitCode).toBe(4);
    }
  });

  test("maps Asana 4xx categories without parsing messages", () => {
    const cases = [
      { status: 400, code: "asana-api" },
      { status: 401, code: "auth-failed" },
      { status: 403, code: "auth-failed" },
      { status: 404, code: "not-found" },
      { status: 409, code: "conflict" },
      { status: 412, code: "conflict" },
      { status: 422, code: "asana-api" },
    ] as const;
    for (const fixture of cases) {
      const normalized = normalizeError({
        status: fixture.status,
        body: { errors: [{ message: "Asana rejected the request" }] },
      });
      expect(normalized.code).toBe(fixture.code);
      expect(errorPayload(normalized).error.code).toBe(fixture.code);
    }
  });

  test("does not serialize raw HTTP or SDK objects", () => {
    const normalized = normalizeError({
      status: 422,
      response: {
        status: 422,
        body: {
          errors: [{ message: "Invalid task" }],
          authorization: "RAW_AUTHORIZATION_MARKER",
          debug: { request: "RAW_SDK_REQUEST_MARKER" },
        },
        request: { headers: { authorization: "RAW_REQUEST_MARKER" } },
      },
    });
    const payload = errorPayload(normalized);
    expect(payload.error.details).toEqual({
      http_status: 422,
      errors: ["Invalid task"],
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("RAW_AUTHORIZATION_MARKER");
    expect(serialized).not.toContain("RAW_SDK_REQUEST_MARKER");
    expect(serialized).not.toContain("RAW_REQUEST_MARKER");
  });

  test("classifies storage failures structurally", () => {
    expect(normalizeError({
      name: "OperationJournalError",
      code: "LOCKED",
      message: "locked",
    }).code).toBe("storage-locked");
    expect(normalizeError({
      name: "OperationJournalError",
      code: "INVALID_RECORD",
      message: "invalid",
    }).code).toBe("storage-invalid");
  });

  test("uses a narrow allowlist for transport failures", () => {
    expect(normalizeError({ code: "ENOTFOUND", message: "DNS lookup failed" }).code)
      .toBe("network");
    expect(normalizeError({
      cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
      message: "connect timeout",
    }).code).toBe("network");
    expect(normalizeError(new TypeError("Unable to connect. Is the computer able to access the URL?")).code)
      .toBe("network");
    expect(normalizeError(new TypeError("fetch failed")).code).toBe("network");
    expect(normalizeError(new TypeError("Cannot read properties of undefined")).code)
      .toBe("internal");
    expect(normalizeError(new Error("Unable to connect")).code).toBe("internal");
  });

  test("publishes and validates the real secure wire error schema", async () => {
    const catalog = z.looseObject({
      error_schema_id: z.literal(AGENT_ERROR_SCHEMA_ID),
      error_schema: jsonObjectSchema,
    }).parse((await runCli(["agent", "schema"])).value);
    const schemaBoundary = z.custom<Parameters<typeof z.fromJSONSchema>[0]>(
      (value) => typeof value === "object" && value !== null,
    );
    const published = z.fromJSONSchema(schemaBoundary.parse(catalog.error_schema));
    for (const code of ["stale", "expired", "unknown-result", "network"] as const) {
      const wire = secureAgentEnvelope(errorPayload(new CliError(code, "test error")));
      expect(published.safeParse(wire).success).toBe(true);
    }
    expect(catalog.error_schema.$id).toBe(AGENT_ERROR_SCHEMA_ID);
  });
});
