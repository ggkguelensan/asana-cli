import { afterEach, describe, expect, test } from "bun:test";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CLI_VERSION } from "../src/version";
import { runCommand } from "./support/process";
import { TemporaryDirectories } from "./support/temp";

const temporaryDirectories = new TemporaryDirectories();

async function runPackageContentCheck(binaryPath: string): Promise<Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>> {
  return runCommand([
    process.execPath,
    "run",
    "--no-env-file",
    "scripts/check-package-content.ts",
    binaryPath,
  ]);
}

afterEach(async () => {
  await temporaryDirectories.cleanup();
});

describe("package-content artifact verifier", () => {
  test("rejects the explicitly selected artifact when its reported version differs from the compiled CLI", async () => {
    const artifact = join(
      await temporaryDirectories.create("asana-cli-package-content-"),
      "wrong-version-artifact",
    );
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
