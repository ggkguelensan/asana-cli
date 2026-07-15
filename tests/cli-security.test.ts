import { describe, expect, test } from "bun:test";

async function run(args: string[], options: { stdin?: string; env?: Record<string, string> } = {}) {
  const child = Bun.spawn([process.execPath, "run", "--no-env-file", "src/index.ts", ...args], {
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env, ...options.env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (options.stdin !== undefined) {
    child.stdin.write(options.stdin);
  }
  child.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("CLI security contract", () => {
  test("never accepts a credential option", async () => {
    const canary = "ARGV_CANARY_SECRET_123456";
    const result = await run(["me", "--token", canary], {
      env: { ASANA_ACCESS_TOKEN: "" },
    });
    expect(result.exitCode).toBe(2);
    expect(`${result.stdout}${result.stderr}`).not.toContain(canary);
    expect(JSON.parse(result.stderr).error.message).toContain("forbidden");
  });

  test("agent write is denied by default before auth or network", async () => {
    const result = await run(["agent", "apply-comment", "--input", "-"], {
      stdin: '{"plan":{}}',
      env: { ASANA_ACCESS_TOKEN: "", ASANA_PAT: "", ASANA_CLI_AGENT_POLICY: "read" },
    });
    expect(result.exitCode).toBe(2);
    const payload = JSON.parse(result.stderr);
    expect(payload.schema).toBe("asana-cli.agent.v1");
    expect(payload.result.error.message).toContain("writes are disabled");
  });

  test("blocks an outbound update containing a local credential", async () => {
    const canary = "LOCAL_ENV_CANARY_SECRET_123456";
    const input = JSON.stringify({
      task_gid: "123",
      patch: { notes: `never send ${canary}` },
    });
    const result = await run(["agent", "prepare-task-update", "--input", "-"], {
      stdin: input,
      env: { ASANA_ACCESS_TOKEN: canary },
    });
    expect(result.exitCode).toBe(2);
    expect(`${result.stdout}${result.stderr}`).not.toContain(canary);
    expect(JSON.parse(result.stderr).result.error.message).toContain("contains a credential");
  });
});
