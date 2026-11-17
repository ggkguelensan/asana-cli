import { describe, expect, test } from "bun:test";
import { runSourceCli } from "./support/process";

describe("CLI security contract", () => {
  test("never accepts or echoes a credential option", async () => {
    const canary = "ARGV_CANARY_SECRET_123456";
    const result = await runSourceCli(["me", "--token", canary]);
    expect(result.exitCode).toBe(2);
    expect(`${result.stdout}${result.stderr}`).not.toContain(canary);
    expect(JSON.parse(result.stderr).error.code).toBe("policy-denied");
  });
  test("rejects removed commands and options before authentication", async () => {
    for (const args of [["agent"], ["agent-setup"], ["integrations"], ["context"], ["update"], ["insights"], ["--agents"], ["me", "--agent"], ["task", "find-git", "ref"]]) {
      const result = await runSourceCli(args, { env: { ASANA_ACCESS_TOKEN: "", ASANA_PAT: "" } });
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).error.code).toBe("usage");
    }
  });
  test("ignores legacy environment switches and always returns plain JSON", async () => {
    const result = await runSourceCli(["api", "list"], { env: { ASANA_CLI_AGENT: "1", ASANA_CLI_AGENT_POLICY: "read" } });
    expect(result.exitCode).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.classes).toContain("TasksApi");
    expect(value.result).toBeUndefined();
    expect(value.agent_protocol_version).toBeUndefined();
  });
});
