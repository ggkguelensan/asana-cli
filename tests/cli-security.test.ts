import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { runSourceCli } from "./support/process";

const humanErrorSchema = z.looseObject({
  error: z.looseObject({ message: z.string() }),
});

const agentErrorSchema = z.looseObject({
  schema: z.string(),
  result: z.looseObject({
    error: z.looseObject({ message: z.string() }),
  }),
});

function decode<S extends z.ZodType>(text: string, schema: S): z.output<S> {
  const value: unknown = JSON.parse(text);
  return schema.parse(value);
}

describe("CLI security contract", () => {
  test("never accepts a credential option", async () => {
    const canary = "ARGV_CANARY_SECRET_123456";
    const result = await runSourceCli(["me", "--token", canary], {
      env: { ASANA_ACCESS_TOKEN: "" },
    });
    expect(result.exitCode).toBe(2);
    expect(`${result.stdout}${result.stderr}`).not.toContain(canary);
    expect(decode(result.stderr, humanErrorSchema).error.message).toContain("forbidden");
  });

  test("agent write is denied by default before auth or network", async () => {
    const result = await runSourceCli([
      "agent",
      "apply",
      "--operation-id",
      "00000000-0000-4000-8000-000000000001",
    ], {
      env: { ASANA_ACCESS_TOKEN: "", ASANA_PAT: "", ASANA_CLI_AGENT_POLICY: "read" },
    });
    expect(result.exitCode).toBe(2);
    const payload = decode(result.stderr, agentErrorSchema);
    expect(payload.schema).toBe("asana-cli.agent.v2");
    expect(payload.result.error.message).toContain("writes are disabled");
  });

  test("blocks an outbound update containing a local credential", async () => {
    const canary = "LOCAL_ENV_CANARY_SECRET_123456";
    const input = JSON.stringify({
      task_gid: "123",
      patch: { notes: `never send ${canary}` },
    });
    const result = await runSourceCli(["agent", "prepare-task-update", "--input", "-"], {
      stdin: input,
      env: { ASANA_ACCESS_TOKEN: canary },
    });
    expect(result.exitCode).toBe(2);
    expect(`${result.stdout}${result.stderr}`).not.toContain(canary);
    expect(decode(result.stderr, agentErrorSchema).result.error.message)
      .toContain("contains a credential");
  });

  test("agent input rejects unknown fields before network I/O", async () => {
    const result = await runSourceCli(["agent", "my-tasks", "--input", "-"], {
      stdin: '{"max_results":10,"unexpected":true}',
      env: { ASANA_ACCESS_TOKEN: "STRICT_AGENT_INPUT_CANARY" },
    });
    expect(result.exitCode).toBe(2);
    expect(decode(result.stderr, agentErrorSchema).result.error.message)
      .toContain("Unrecognized key");
  });
});
