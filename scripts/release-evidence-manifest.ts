import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { GENERATED_CLIENT_COMPATIBILITY } from "../generated/client-compatibility";
import {
  INTEGRATION_BUNDLE_VERSION,
  INTEGRATION_CLIENTS,
  integrationClientIdSchema,
} from "../integrations/clients";
import {
  AGENT_PROTOCOL_COMPATIBILITY,
  AGENT_PROTOCOL_VERSION,
  CLI_VERSION,
} from "../src/version";
import {
  clientEvalSubjectSha256,
  integrationBundleSha256,
} from "./client-eval-contract";
import { integrationLifecycleEvidenceSchema } from "./integration-lifecycle-e2e";
import { releaseSbomSchema } from "./release-sbom";
import { reproducibleBuildEvidenceSchema } from "./reproducible-build";
import { RELEASE_TARGETS, supportedBuildTargetSchema } from "./check-support-matrix";
import {
  BUILD_PROVENANCE_PREDICATE,
  parseSigstoreBundle,
  SPDX_SBOM_PREDICATE,
} from "./sigstore-bundle";

const projectRoot = resolve(import.meta.dir, "..");
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const gitCommitSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
const semverSchema = z.string().regex(
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
);
const tagSchema = z.string().regex(
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
);
const sourceDateEpochSchema = z.coerce.number().int().nonnegative();
const releaseAssetSchema = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/),
  sha256: sha256Schema,
  size_bytes: z.number().int().positive(),
});
const evidenceReferenceSchema = z.strictObject({
  path: z.string().regex(/^evidence\/(?:client-evals|client-adapters)\/[a-z-]+\.json$/),
  sha256: sha256Schema,
  evaluated_commit: gitCommitSchema,
  subject_sha256: sha256Schema,
  contract_sha256: sha256Schema,
  client_version: z.string().min(1).max(128),
  verdict: z.literal("passed"),
});
const qualificationSchema = z.strictObject({
  id: integrationClientIdSchema,
  support: z.enum(["generic", "experimental", "supported"]),
  qualification_kind: z.enum(["generic-contract", "adapter-only", "behavioral-eval"]),
  protocol: z.strictObject({
    minimum: z.number().int().positive(),
    maximum: z.number().int().positive(),
  }),
  evidence: z.union([evidenceReferenceSchema, z.null()]),
});
const targetEvidenceSchema = z.strictObject({
  target: supportedBuildTargetSchema,
  runner: z.string().min(1),
  binary: releaseAssetSchema,
  lifecycle: z.strictObject({
    asset: releaseAssetSchema,
    cases: z.number().int().positive(),
    subject_sha256: sha256Schema,
    bundle_sha256: sha256Schema,
  }),
  sbom: z.strictObject({
    asset: releaseAssetSchema,
    namespace: z.string().url(),
    packages: z.number().int().positive(),
  }),
  reproducibility: z.strictObject({
    asset: releaseAssetSchema,
    comparison: z.literal("byte-identical"),
    rebuild_sha256: sha256Schema,
    build_recipe_sha256: sha256Schema,
  }),
  provenance: z.strictObject({
    asset: releaseAssetSchema,
    predicate_type: z.literal(BUILD_PROVENANCE_PREDICATE),
  }),
  sbom_attestation: z.strictObject({
    asset: releaseAssetSchema,
    predicate_type: z.literal(SPDX_SBOM_PREDICATE),
  }),
});

export const releaseEvidenceManifestSchema = z.strictObject({
  schema: z.literal("asana-cli.release-evidence.v1"),
  release: z.strictObject({
    tag: tagSchema,
    version: semverSchema,
    source_commit: gitCommitSchema,
    source_date_epoch: z.number().int().nonnegative(),
    created: z.iso.datetime({ offset: false }),
    workflow: z.strictObject({
      path: z.literal(".github/workflows/release.yml"),
      sha256: sha256Schema,
    }),
    contract: z.strictObject({
      path: z.literal("scripts/release-contract.ts"),
      sha256: sha256Schema,
    }),
    lock_sha256: sha256Schema,
  }),
  protocol: z.strictObject({
    cli_version: semverSchema,
    agent_protocol_version: z.number().int().positive(),
    compatibility: z.strictObject({
      minimum: z.number().int().positive(),
      maximum: z.number().int().positive(),
    }),
    integration_bundle_version: semverSchema,
    integration_bundle_sha256: sha256Schema,
  }),
  support: z.strictObject({
    platforms: z.tuple([z.literal("darwin"), z.literal("linux")]),
    targets: z.array(targetEvidenceSchema).length(RELEASE_TARGETS.length),
  }),
  clients: z.strictObject({
    compatibility_schema: z.literal("asana-cli.client-compatibility.v1"),
    generated_compatibility_sha256: sha256Schema,
    evaluated_subject_sha256: sha256Schema,
    qualifications: z.array(qualificationSchema).length(
      Object.keys(INTEGRATION_CLIENTS).length,
    ),
  }),
  homebrew: z.strictObject({
    formula: releaseAssetSchema,
    binary_targets: z.tuple([
      z.literal("asana-cli-darwin-arm64"),
      z.literal("asana-cli-darwin-x64"),
      z.literal("asana-cli-linux-arm64"),
      z.literal("asana-cli-linux-x64"),
    ]),
  }),
  integrity: z.strictObject({
    checksum_manifest: z.literal("SHA256SUMS"),
    checksum_attestation: z.literal("SHA256SUMS.sigstore.json"),
    evidence_manifest_in_checksum_set: z.literal(true),
  }),
});

export type ReleaseEvidenceManifest = z.output<typeof releaseEvidenceManifestSchema>;

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function asset(directory: string, name: string): Promise<z.output<typeof releaseAssetSchema>> {
  const bytes = await readFile(join(directory, name));
  return releaseAssetSchema.parse({
    name,
    sha256: sha256(bytes),
    size_bytes: bytes.byteLength,
  });
}

async function jsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function clientQualifications(): Promise<
  readonly z.output<typeof qualificationSchema>[]
> {
  const qualifications: z.output<typeof qualificationSchema>[] = [];
  for (const id of Object.keys(INTEGRATION_CLIENTS).sort()) {
    const clientId = integrationClientIdSchema.parse(id);
    const client = INTEGRATION_CLIENTS[clientId];
    const qualification = client.qualification;
    let evidence: z.output<typeof evidenceReferenceSchema> | null = null;
    if (qualification.evidence !== null) {
      const path = qualification.evidence;
      const text = await readFile(resolve(projectRoot, path), "utf8");
      if (sha256(text) !== qualification.evidence_sha256) {
        throw new Error(`${clientId} qualification digest does not match ${path}`);
      }
      const parsed = z.looseObject({
        evaluated_commit: gitCommitSchema,
        subject_sha256: sha256Schema,
        contract_sha256: sha256Schema,
        client_version: z.string().min(1).max(128),
        verdict: z.literal("passed"),
      }).parse(JSON.parse(text) as unknown);
      evidence = evidenceReferenceSchema.parse({
        path,
        sha256: qualification.evidence_sha256,
        evaluated_commit: parsed.evaluated_commit,
        subject_sha256: parsed.subject_sha256,
        contract_sha256: parsed.contract_sha256,
        client_version: parsed.client_version,
        verdict: parsed.verdict,
      });
    }
    qualifications.push(qualificationSchema.parse({
      id: clientId,
      support: client.support,
      qualification_kind: qualification.kind,
      protocol: client.protocol,
      evidence,
    }));
  }
  return qualifications;
}

export async function buildReleaseEvidenceManifest(
  directoryArgument: string,
  tagArgument: string,
  sourceCommitArgument: string,
  sourceDateEpochArgument: string | number,
): Promise<ReleaseEvidenceManifest> {
  const directory = resolve(directoryArgument);
  const tag = tagSchema.parse(tagArgument);
  if (tag !== `v${CLI_VERSION}`) {
    throw new Error(`Release evidence tag ${tag} must match CLI version v${CLI_VERSION}`);
  }
  const sourceCommit = gitCommitSchema.parse(sourceCommitArgument);
  const sourceDateEpoch = sourceDateEpochSchema.parse(sourceDateEpochArgument);
  const [
    workflowBytes,
    contractBytes,
    lockBytes,
    compatibilityBytes,
    evaluatedSubjectSha256,
    qualifications,
    formula,
  ] = await Promise.all([
    readFile(resolve(projectRoot, ".github/workflows/release.yml")),
    readFile(resolve(projectRoot, "scripts/release-contract.ts")),
    readFile(resolve(projectRoot, "bun.lock")),
    readFile(resolve(projectRoot, "generated/client-compatibility.ts")),
    clientEvalSubjectSha256(),
    clientQualifications(),
    asset(directory, "asana-cli.rb"),
  ]);

  const targets: z.output<typeof targetEvidenceSchema>[] = [];
  for (const releaseTarget of RELEASE_TARGETS) {
    const output = releaseTarget.output;
    const binary = await asset(directory, output);
    const lifecycleName = `${output}.lifecycle.json`;
    const sbomName = `${output}.spdx.json`;
    const reproducibilityName = `${output}.reproducibility.json`;
    const provenanceName = `${output}.provenance.sigstore.json`;
    const sbomAttestationName = `${output}.sbom.sigstore.json`;
    const [
      lifecycle,
      sbom,
      reproducibility,
      lifecycleAsset,
      sbomAsset,
      reproducibilityAsset,
      provenanceAsset,
      sbomAttestationAsset,
      provenanceBundle,
      sbomBundle,
    ] = await Promise.all([
      jsonFile(join(directory, lifecycleName)).then((value) =>
        integrationLifecycleEvidenceSchema.parse(value)
      ),
      jsonFile(join(directory, sbomName)).then((value) => releaseSbomSchema.parse(value)),
      jsonFile(join(directory, reproducibilityName)).then((value) =>
        reproducibleBuildEvidenceSchema.parse(value)
      ),
      asset(directory, lifecycleName),
      asset(directory, sbomName),
      asset(directory, reproducibilityName),
      asset(directory, provenanceName),
      asset(directory, sbomAttestationName),
      jsonFile(join(directory, provenanceName)),
      jsonFile(join(directory, sbomAttestationName)),
    ]);
    if (
      lifecycle.target !== releaseTarget.target ||
      lifecycle.binary_sha256 !== binary.sha256 ||
      reproducibility.target !== releaseTarget.target ||
      reproducibility.reference.sha256 !== binary.sha256 ||
      reproducibility.rebuild.sha256 !== binary.sha256 ||
      sbom.files[0].checksums[0]?.checksumValue !== binary.sha256
    ) {
      throw new Error(`${output} evidence does not bind the selected target binary`);
    }
    parseSigstoreBundle(provenanceBundle, {
      name: output,
      sha256: binary.sha256,
      predicateType: BUILD_PROVENANCE_PREDICATE,
    });
    parseSigstoreBundle(sbomBundle, {
      name: output,
      sha256: binary.sha256,
      predicateType: SPDX_SBOM_PREDICATE,
    });
    targets.push(targetEvidenceSchema.parse({
      target: releaseTarget.target,
      runner: releaseTarget.runner,
      binary,
      lifecycle: {
        asset: lifecycleAsset,
        cases: lifecycle.cases.length,
        subject_sha256: lifecycle.subject_sha256,
        bundle_sha256: lifecycle.bundle_sha256,
      },
      sbom: {
        asset: sbomAsset,
        namespace: sbom.documentNamespace,
        packages: sbom.packages.length,
      },
      reproducibility: {
        asset: reproducibilityAsset,
        comparison: reproducibility.comparison,
        rebuild_sha256: reproducibility.rebuild.sha256,
        build_recipe_sha256: reproducibility.build_recipe_sha256,
      },
      provenance: {
        asset: provenanceAsset,
        predicate_type: BUILD_PROVENANCE_PREDICATE,
      },
      sbom_attestation: {
        asset: sbomAttestationAsset,
        predicate_type: SPDX_SBOM_PREDICATE,
      },
    }));
  }

  return releaseEvidenceManifestSchema.parse({
    schema: "asana-cli.release-evidence.v1",
    release: {
      tag,
      version: CLI_VERSION,
      source_commit: sourceCommit,
      source_date_epoch: sourceDateEpoch,
      created: new Date(sourceDateEpoch * 1000).toISOString(),
      workflow: {
        path: ".github/workflows/release.yml",
        sha256: sha256(workflowBytes),
      },
      contract: {
        path: "scripts/release-contract.ts",
        sha256: sha256(contractBytes),
      },
      lock_sha256: sha256(lockBytes),
    },
    protocol: {
      cli_version: CLI_VERSION,
      agent_protocol_version: AGENT_PROTOCOL_VERSION,
      compatibility: AGENT_PROTOCOL_COMPATIBILITY,
      integration_bundle_version: INTEGRATION_BUNDLE_VERSION,
      integration_bundle_sha256: integrationBundleSha256(),
    },
    support: {
      platforms: ["darwin", "linux"],
      targets,
    },
    clients: {
      compatibility_schema: GENERATED_CLIENT_COMPATIBILITY.schema,
      generated_compatibility_sha256: sha256(compatibilityBytes),
      evaluated_subject_sha256: evaluatedSubjectSha256,
      qualifications,
    },
    homebrew: {
      formula,
      binary_targets: [
        "asana-cli-darwin-arm64",
        "asana-cli-darwin-x64",
        "asana-cli-linux-arm64",
        "asana-cli-linux-x64",
      ],
    },
    integrity: {
      checksum_manifest: "SHA256SUMS",
      checksum_attestation: "SHA256SUMS.sigstore.json",
      evidence_manifest_in_checksum_set: true,
    },
  });
}

export async function generateReleaseEvidenceManifest(
  directoryArgument: string,
  tagArgument: string,
  sourceCommitArgument: string,
  sourceDateEpochArgument: string | number,
  outputArgument: string,
): Promise<ReleaseEvidenceManifest> {
  const output = resolve(outputArgument);
  if (basename(output) !== "release-evidence.json") {
    throw new Error("Release evidence output must be named release-evidence.json");
  }
  const manifest = await buildReleaseEvidenceManifest(
    directoryArgument,
    tagArgument,
    sourceCommitArgument,
    sourceDateEpochArgument,
  );
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

export async function verifyReleaseEvidenceManifest(
  directoryArgument: string,
  tagArgument: string,
  sourceCommitArgument: string,
  sourceDateEpochArgument: string | number,
): Promise<ReleaseEvidenceManifest> {
  const directory = resolve(directoryArgument);
  const actual = releaseEvidenceManifestSchema.parse(
    await jsonFile(join(directory, "release-evidence.json")),
  );
  const expected = await buildReleaseEvidenceManifest(
    directory,
    tagArgument,
    sourceCommitArgument,
    sourceDateEpochArgument,
  );
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Release evidence manifest is stale for the selected release payload");
  }
  return actual;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--output");
  const output = outputIndex === -1 ? undefined : args[outputIndex + 1];
  const positionals = outputIndex === -1
    ? args
    : args.filter((_, index) => index !== outputIndex && index !== outputIndex + 1);
  const [directory, tag, sourceCommit, sourceDateEpoch, ...unexpected] = positionals;
  if (
    !directory ||
    !tag ||
    !sourceCommit ||
    !sourceDateEpoch ||
    !output ||
    unexpected.length > 0 ||
    outputIndex + 2 !== args.length
  ) {
    throw new Error(
      "Usage: bun run scripts/release-evidence-manifest.ts DIRECTORY TAG SOURCE_COMMIT SOURCE_DATE_EPOCH --output DIRECTORY/release-evidence.json",
    );
  }
  const manifest = await generateReleaseEvidenceManifest(
    directory,
    tag,
    sourceCommit,
    sourceDateEpoch,
    output,
  );
  process.stdout.write(
    `Generated release evidence manifest for ${manifest.support.targets.length} targets and ${manifest.clients.qualifications.length} clients\n`,
  );
}
