import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifyReleaseSbom } from "../scripts/check-release-sbom";
import {
  buildReleaseSbom,
  generateReleaseSbom,
  releaseSbomSchema,
} from "../scripts/release-sbom";

const projectRoot = resolve(import.meta.dir, "..");
const sourceCommit = "a".repeat(40);
const binaryBytes = new TextEncoder().encode("deterministic test executable\n");

async function repositoryInputs(): Promise<Readonly<{
  lockText: string;
  packageValue: unknown;
}>> {
  const [lockText, packageValue] = await Promise.all([
    Bun.file(resolve(projectRoot, "bun.lock")).text(),
    Bun.file(resolve(projectRoot, "package.json")).json() as Promise<unknown>,
  ]);
  return { lockText, packageValue };
}

describe("release SPDX SBOM", () => {
  test("binds one target binary to source, Bun, and the locked production closure", async () => {
    const repository = await repositoryInputs();
    const input = {
      binaryName: "asana-cli-darwin-arm64",
      binaryBytes,
      target: "bun-darwin-arm64" as const,
      sourceCommit,
      sourceDateEpoch: 1_700_000_000,
      ...repository,
    };

    const first = buildReleaseSbom(input);
    const second = buildReleaseSbom(input);
    const binarySha256 = createHash("sha256").update(binaryBytes).digest("hex");

    expect(first).toEqual(second);
    expect(releaseSbomSchema.parse(first)).toEqual(first);
    expect(first.creationInfo.created).toBe("2023-11-14T22:13:20.000Z");
    expect(first.documentNamespace).toContain(sourceCommit);
    expect(first.documentComment).toContain(`binary_sha256=${binarySha256}`);
    expect(first.documentComment).toMatch(/bun_lock_sha256=[a-f0-9]{64}/);
    expect(first.files[0].checksums[0]?.checksumValue).toBe(binarySha256);
    expect(first.packages[0]?.checksums[0]?.checksumValue).toBe(binarySha256);
    expect(first.packages.map((entry) => entry.name)).toContain("Bun");
    expect(first.packages.map((entry) => entry.name)).toContain("asana");
    expect(first.packages.map((entry) => entry.name)).toContain("zod");
    expect(first.packages.length).toBeGreaterThan(70);
    expect(first.relationships).toContainEqual({
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: "SPDXRef-Package-asana-cli",
    });
  });

  test("rejects target, workspace, dependency, and integrity drift", async () => {
    const repository = await repositoryInputs();
    const valid = {
      binaryName: "asana-cli-darwin-arm64",
      binaryBytes,
      target: "bun-darwin-arm64" as const,
      sourceCommit,
      sourceDateEpoch: 1_700_000_000,
      ...repository,
    };

    expect(() => buildReleaseSbom({
      ...valid,
      binaryName: "asana-cli-linux-arm64",
    })).toThrow("must describe asana-cli-darwin-arm64");

    expect(() => buildReleaseSbom({
      ...valid,
      packageValue: {
        ...(valid.packageValue as Record<string, unknown>),
        dependencies: { asana: "3.1.12" },
      },
    })).toThrow("production dependencies do not match bun.lock");

    const lock = Bun.JSONC.parse(valid.lockText) as {
      workspaces: Record<string, { name: string }>;
      packages: Record<string, [string, string, object, string]>;
    };
    lock.workspaces[""] = { name: "foreign-package" };
    expect(() => buildReleaseSbom({
      ...valid,
      lockText: JSON.stringify(lock),
    })).toThrow("root workspace does not match package.json");

    const invalidIntegrity = Bun.JSONC.parse(valid.lockText) as {
      packages: Record<string, [string, string, object, string]>;
    };
    const zodPackage = invalidIntegrity.packages.zod;
    if (!zodPackage) throw new Error("Test fixture is missing zod");
    zodPackage[3] = "sha512-invalid";
    expect(() => buildReleaseSbom({
      ...valid,
      lockText: JSON.stringify(invalidIntegrity),
    })).toThrow();
  });

  test("regenerates and verifies the exact persisted SBOM bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "asana-cli-sbom-test-"));
    try {
      const binaryPath = join(root, "asana-cli-darwin-arm64");
      const sbomPath = join(root, "asana-cli-darwin-arm64.spdx.json");
      await writeFile(binaryPath, binaryBytes);
      await generateReleaseSbom(
        binaryPath,
        "bun-darwin-arm64",
        sourceCommit,
        1_700_000_000,
        sbomPath,
      );

      const verified = await verifyReleaseSbom(
        binaryPath,
        "bun-darwin-arm64",
        sourceCommit,
        1_700_000_000,
        sbomPath,
      );
      expect(verified.files[0].fileName).toBe("./asana-cli-darwin-arm64");

      const tampered = (await readFile(sbomPath, "utf8")).replace(
        "source_commit=",
        "source_commit=tampered-",
      );
      await writeFile(sbomPath, tampered);
      expect(verifyReleaseSbom(
        binaryPath,
        "bun-darwin-arm64",
        sourceCommit,
        1_700_000_000,
        sbomPath,
      )).rejects.toThrow("does not exactly describe");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
