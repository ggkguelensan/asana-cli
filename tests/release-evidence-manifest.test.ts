import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { INTEGRATION_CLIENT_IDS } from "../integrations/clients";
import {
  clientEvalSubjectSha256,
  integrationBundleSha256,
} from "../scripts/client-eval-contract";
import { buildHomebrewFormula } from "../scripts/homebrew-formula";
import {
  buildReleaseEvidenceManifest,
  generateReleaseEvidenceManifest,
  releaseEvidenceManifestSchema,
  verifyReleaseEvidenceManifest,
} from "../scripts/release-evidence-manifest";
import { buildReleaseSbom } from "../scripts/release-sbom";
import { createReproducibleBuildEvidence } from "../scripts/reproducible-build";
import { RELEASE_TARGETS } from "../scripts/check-support-matrix";
import {
  BUILD_PROVENANCE_PREDICATE,
  SPDX_SBOM_PREDICATE,
} from "../scripts/sigstore-bundle";
import { CLI_VERSION } from "../src/version";

const projectRoot = resolve(import.meta.dir, "..");
const sourceCommit = "a".repeat(40);
const sourceDateEpoch = 1_700_000_000;
const releaseTag = `v${CLI_VERSION}`;
const releaseBaseUrl =
  `https://github.com/ggkguelensan/asana-cli/releases/download/${releaseTag}`;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sigstoreBundle(
  name: string,
  digest: string,
  predicateType: string,
): unknown {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name, digest: { sha256: digest } }],
    predicateType,
    predicate: {},
  };
  return {
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: {},
    dsseEnvelope: {
      payloadType: "application/vnd.in-toto+json",
      payload: Buffer.from(JSON.stringify(statement), "utf8").toString("base64"),
      signatures: [{ sig: "a".repeat(64) }],
    },
  };
}

async function releaseFixture(directory: string): Promise<void> {
  const [lockText, packageValue, subjectSha256] = await Promise.all([
    readFile(resolve(projectRoot, "bun.lock"), "utf8"),
    Bun.file(resolve(projectRoot, "package.json")).json() as Promise<unknown>,
    clientEvalSubjectSha256(),
  ]);
  const homebrewChecksums: Record<string, string> = {};
  for (const releaseTarget of RELEASE_TARGETS) {
    const binaryBytes = new TextEncoder().encode(
      `fixture ${releaseTarget.target} standalone executable\n`,
    );
    const binarySha256 = sha256(binaryBytes);
    await writeFile(join(directory, releaseTarget.output), binaryBytes);
    if (!releaseTarget.output.includes("musl")) {
      homebrewChecksums[releaseTarget.output] = binarySha256;
    }
    const platform = releaseTarget.target.startsWith("bun-darwin")
      ? "darwin"
      : "linux";
    const architecture = releaseTarget.target.includes("arm64") ? "arm64" : "x64";
    const lifecycle = {
      schema: "asana-cli.integration-lifecycle-evidence.v1",
      target: releaseTarget.target,
      platform,
      architecture,
      subject_sha256: subjectSha256,
      binary_sha256: binarySha256,
      bundle_sha256: integrationBundleSha256(),
      cases: INTEGRATION_CLIENT_IDS.flatMap((client) =>
        (["user", "project"] as const).map((scope) => ({
          client,
          scope,
          status: "passed",
        }))
      ),
    };
    await writeFile(
      join(directory, `${releaseTarget.output}.lifecycle.json`),
      `${JSON.stringify(lifecycle, null, 2)}\n`,
    );
    const sbom = buildReleaseSbom({
      binaryName: releaseTarget.output,
      binaryBytes,
      target: releaseTarget.target,
      sourceCommit,
      sourceDateEpoch,
      lockText,
      packageValue,
    });
    await writeFile(
      join(directory, `${releaseTarget.output}.spdx.json`),
      `${JSON.stringify(sbom, null, 2)}\n`,
    );
    const reproducibility = await createReproducibleBuildEvidence({
      target: releaseTarget.target,
      sourceCommit,
      sourceDateEpoch,
      bunVersion: Bun.version,
      lockText,
      buildRecipeSha256: "b".repeat(64),
      artifactName: releaseTarget.output,
      referenceBytes: binaryBytes,
      rebuildBytes: binaryBytes,
    });
    await writeFile(
      join(directory, `${releaseTarget.output}.reproducibility.json`),
      `${JSON.stringify(reproducibility, null, 2)}\n`,
    );
    await Promise.all([
      writeFile(
        join(directory, `${releaseTarget.output}.provenance.sigstore.json`),
        `${JSON.stringify(sigstoreBundle(
          releaseTarget.output,
          binarySha256,
          BUILD_PROVENANCE_PREDICATE,
        ))}\n`,
      ),
      writeFile(
        join(directory, `${releaseTarget.output}.sbom.sigstore.json`),
        `${JSON.stringify(sigstoreBundle(
          releaseTarget.output,
          binarySha256,
          SPDX_SBOM_PREDICATE,
        ))}\n`,
      ),
    ]);
  }
  await writeFile(join(directory, "asana-cli.rb"), buildHomebrewFormula({
    version: CLI_VERSION,
    tag: releaseTag,
    baseUrl: releaseBaseUrl,
    checksums: homebrewChecksums,
  }));
}

describe("machine-readable release evidence manifest", () => {
  test("links source, protocol, every target, Homebrew and client qualification evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "asana-cli-release-evidence-"));
    try {
      await mkdir(root, { recursive: true });
      await releaseFixture(root);
      const manifest = await buildReleaseEvidenceManifest(
        root,
        releaseTag,
        sourceCommit,
        sourceDateEpoch,
      );

      expect(releaseEvidenceManifestSchema.parse(manifest)).toEqual(manifest);
      expect(manifest.release.source_commit).toBe(sourceCommit);
      expect(manifest.protocol.agent_protocol_version).toBe(2);
      expect(manifest.support.platforms).toEqual(["darwin", "linux"]);
      expect(manifest.support.targets).toHaveLength(6);
      expect(manifest.support.targets.every((target) =>
        target.binary.sha256 === target.reproducibility.rebuild_sha256
      )).toBeTrue();
      expect(manifest.clients.qualifications).toHaveLength(9);
      expect(
        manifest.clients.qualifications
          .filter((client) => client.support === "supported")
          .map((client) => client.id),
      ).toEqual(["claude-code", "codex"]);
      expect(manifest.homebrew.binary_targets).toHaveLength(4);
      expect(manifest.integrity.evidence_manifest_in_checksum_set).toBeTrue();

      const output = join(root, "release-evidence.json");
      await generateReleaseEvidenceManifest(
        root,
        releaseTag,
        sourceCommit,
        sourceDateEpoch,
        output,
      );
      expect(await verifyReleaseEvidenceManifest(
        root,
        releaseTag,
        sourceCommit,
        sourceDateEpoch,
      )).toEqual(manifest);

      const tampered = JSON.parse(await readFile(output, "utf8")) as {
        release: { source_commit: string };
      };
      tampered.release.source_commit = "c".repeat(40);
      await writeFile(output, `${JSON.stringify(tampered, null, 2)}\n`);
      expect(verifyReleaseEvidenceManifest(
        root,
        releaseTag,
        sourceCommit,
        sourceDateEpoch,
      )).rejects.toThrow("stale");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a release tag that does not match the compiled CLI version", async () => {
    const root = await mkdtemp(join(tmpdir(), "asana-cli-release-evidence-tag-"));
    try {
      expect(buildReleaseEvidenceManifest(
        root,
        "v9.9.9",
        sourceCommit,
        sourceDateEpoch,
      )).rejects.toThrow("must match CLI version");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
