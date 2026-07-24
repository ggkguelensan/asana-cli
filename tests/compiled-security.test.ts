import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CLI_VERSION } from "../src/version";

const binary = resolve(import.meta.dir, "../dist/asana-cli");
const projectRoot = resolve(import.meta.dir, "..");
const created: string[] = [];

async function executeBinary(
  args: readonly string[],
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<Readonly<{ stdout: string; stderr: string; exitCode: number }>> {
  const child = Bun.spawn([binary, ...args], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("compiled runtime isolation", () => {
  test.skipIf(!existsSync(binary))("does not autoload runtime .env or bunfig preload", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "asana-cli-runtime-"));
    created.push(cwd);
    const marker = join(cwd, "PRELOAD_RAN");
    await Bun.write(join(cwd, ".env"), "NODE_TLS_REJECT_UNAUTHORIZED=0\n");
    await Bun.write(join(cwd, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
    await Bun.write(join(cwd, "preload.ts"), `await Bun.write(${JSON.stringify(marker)}, "ran");\n`);

    const env = { ...process.env };
    delete env.NODE_TLS_REJECT_UNAUTHORIZED;
    const { stdout, stderr, exitCode } = await executeBinary(["--version"], cwd, env);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(CLI_VERSION);
    expect(stderr).toBe("");
    expect(existsSync(marker)).toBe(false);
  });

  test.skipIf(!existsSync(binary))("maps an invalid context state root to a stable error", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "asana-cli-invalid-state-"));
    created.push(cwd);
    const result = await executeBinary(
      ["context", "alias", "list"],
      cwd,
      {
        ...process.env,
        HOME: "relative-home",
        XDG_STATE_HOME: "relative-state",
      },
    );
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: {
        code: "storage-invalid",
        message: "Local context state is unavailable or unsafe",
      },
    });
    expect(existsSync(join(cwd, "relative-home"))).toBe(false);
    expect(existsSync(join(cwd, "relative-state"))).toBe(false);
  });

  test.skipIf(!existsSync(binary))("runs the no-PAT context lifecycle from the executable", async () => {
    const stateHome = await mkdtemp(join(tmpdir(), "asana-cli-compiled-context-"));
    created.push(stateHome);
    const environment: Record<string, string | undefined> = {
      ...process.env,
      HOME: stateHome,
      XDG_STATE_HOME: stateHome,
    };
    delete environment.ASANA_ACCESS_TOKEN;
    delete environment.ASANA_PAT;
    const alias = "task:platform/dev-014--compiled-context";

    const initial = await executeBinary(
      ["context", "alias", "list", "--compact"],
      projectRoot,
      environment,
    );
    expect(initial.exitCode).toBe(0);
    expect(initial.stderr).toBe("");
    expect(JSON.parse(initial.stdout)).toMatchObject({ revision: 0, aliases: [] });

    const set = await executeBinary(
      ["context", "alias", "set", alias, "--task", "1200000000001", "--compact"],
      projectRoot,
      environment,
    );
    expect(set.exitCode).toBe(0);
    expect(JSON.parse(set.stdout)).toMatchObject({
      revision: 1,
      aliases: [{ qualified_alias: alias, task_gid: "1200000000001" }],
    });

    const activated = await executeBinary(
      ["context", "activate", alias, "--compact"],
      projectRoot,
      environment,
    );
    expect(activated.exitCode).toBe(0);
    expect(JSON.parse(activated.stdout)).toMatchObject({
      worktree_revision: 1,
      active: {
        qualified_alias: alias,
        status: "resolved",
        task_gid: "1200000000001",
      },
    });

    const history = await executeBinary(
      ["context", "history", "--compact"],
      projectRoot,
      environment,
    );
    expect(history.exitCode).toBe(0);
    expect(JSON.parse(history.stdout)).toMatchObject({
      schema: "asana-cli.context-history.v1",
      recent: [{ qualified_alias: alias, status: "resolved" }],
    });
  });
});
