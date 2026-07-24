import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { verifyReleaseWorkflow } from "../scripts/check-release-workflow";

const projectRoot = resolve(import.meta.dir, "..");

async function fixtures(): Promise<Readonly<{
  workflow: string;
  packageValue: unknown;
}>> {
  const [workflow, packageValue] = await Promise.all([
    Bun.file(resolve(projectRoot, ".github/workflows/release.yml")).text(),
    Bun.file(resolve(projectRoot, "package.json")).json() as Promise<unknown>,
  ]);
  return { workflow, packageValue };
}

describe("release supply-chain workflow", () => {
  test("binds all artifacts to the explicit contract and three attestation modes", async () => {
    const input = await fixtures();
    expect(() => verifyReleaseWorkflow(input.workflow, input.packageValue)).not.toThrow();
  });

  test("rejects missing permissions, gates, attestations, and exact package scripts", async () => {
    const input = await fixtures();
    expect(() => verifyReleaseWorkflow(
      input.workflow.replace("id-token: write", "id-token: read"),
      input.packageValue,
    )).toThrow("attestation permissions");
    expect(() => verifyReleaseWorkflow(
      input.workflow.replace("uses: actions/attest@v4", "uses: actions/checkout@v7"),
      input.packageValue,
    )).toThrow("provenance, SBOM, and signed checksums");
    expect(() => verifyReleaseWorkflow(
      input.workflow.replaceAll("bun run release:contract", "bun run check"),
      input.packageValue,
    )).toThrow("release:contract");
    expect(() => verifyReleaseWorkflow(
      input.workflow.replace("subject-path: dist/SHA256SUMS", "subject-path: dist/*"),
      input.packageValue,
    )).toThrow("subject-path: dist/SHA256SUMS");
    expect(() => verifyReleaseWorkflow(
      input.workflow.replace('--user "$(id -u):$(id -g)"', ""),
      input.packageValue,
    )).toThrow("runner UID/GID");
    expect(() => verifyReleaseWorkflow(input.workflow, {
      ...(input.packageValue as Record<string, unknown>),
      scripts: {},
    })).toThrow("generate:release-sbom");
  });
});
