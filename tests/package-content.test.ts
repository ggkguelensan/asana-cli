import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CLI_VERSION } from "../src/version";

const projectRoot = resolve(import.meta.dir, "..");
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asana-cli-package-content-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function runPackageContentCheck(binaryPath: string): Promise<Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>> {
  const child = Bun.spawn([
    process.execPath,
    "run",
    "--no-env-file",
    "scripts/check-package-content.ts",
    binaryPath,
  ], {
    cwd: projectRoot,
    env: { ...process.env },
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
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("package-content artifact verifier", () => {
  test("rejects the explicitly selected artifact when its reported version differs from the compiled CLI", async () => {
    const artifact = join(await temporaryDirectory(), "wrong-version-artifact");
    const reportedVersion = `${CLI_VERSION}-tampered`;
    await writeFile(artifact, [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      `  printf '%s\\n' ${JSON.stringify(reportedVersion)}`,
      "  exit 0",
      "fi",
      "exit 99",
      "",
    ].join("\n"));
    await chmod(artifact, 0o755);

    const result = await runPackageContentCheck(artifact);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      `Artifact version ${JSON.stringify(`${reportedVersion}\n`)} does not exactly match CLI version ${CLI_VERSION}`,
    );
  });
});
