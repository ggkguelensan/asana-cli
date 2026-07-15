import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CLI_VERSION } from "../src/version";

const binary = resolve(import.meta.dir, "../dist/asana-cli");
const created: string[] = [];

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
    const child = Bun.spawn([binary, "--version"], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(CLI_VERSION);
    expect(stderr).toBe("");
    expect(existsSync(marker)).toBe(false);
  });
});
