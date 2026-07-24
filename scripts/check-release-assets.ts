import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { clientEvalSubjectSha256, integrationBundleSha256 } from "./client-eval-contract";
import { verifyHomebrewFormula } from "./homebrew-formula";
import { integrationLifecycleEvidenceSchema } from "./integration-lifecycle-e2e";
import { verifyReleaseChecksums } from "./release-assets";
import { verifyReleaseSbom } from "./check-release-sbom";
import { verifyReproducibleBuildEvidence } from "./reproducible-build";
import { RELEASE_TARGETS } from "./check-support-matrix";
import {
  BUILD_PROVENANCE_PREDICATE,
  SPDX_SBOM_PREDICATE,
  verifySigstoreBundle,
} from "./sigstore-bundle";

const tagSchema = z.string().regex(
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function verifyReleaseAssets(
  directoryArgument: string,
  tagArgument: string,
  sourceCommit: string,
  sourceDateEpoch: string | number,
): Promise<void> {
  const directory = resolve(directoryArgument);
  const tag = tagSchema.parse(tagArgument);
  const [checksumEntries, subjectSha256] = await Promise.all([
    verifyReleaseChecksums(directory),
    clientEvalSubjectSha256(),
    verifyHomebrewFormula(directory, tag),
  ]).then(([entries, subject]) => [entries, subject] as const);
  const checksums = new Map(checksumEntries.map((entry) => [entry.name, entry.sha256]));
  const bundleSha256 = integrationBundleSha256();

  for (const target of RELEASE_TARGETS) {
    const binaryPath = join(directory, target.output);
    const binaryBytes = await readFile(binaryPath);
    const binarySha256 = sha256(binaryBytes);
    if (checksums.get(target.output) !== binarySha256) {
      throw new Error(`${target.output} is not bound by SHA256SUMS`);
    }

    await verifyReleaseSbom(
      binaryPath,
      target.target,
      sourceCommit,
      sourceDateEpoch,
      join(directory, `${target.output}.spdx.json`),
    );
    await verifyReproducibleBuildEvidence(
      binaryPath,
      target.target,
      sourceCommit,
      sourceDateEpoch,
      join(directory, `${target.output}.reproducibility.json`),
    );

    const lifecycle = integrationLifecycleEvidenceSchema.parse(
      JSON.parse(
        await readFile(join(directory, `${target.output}.lifecycle.json`), "utf8"),
      ) as unknown,
    );
    if (
      lifecycle.target !== target.target ||
      lifecycle.binary_sha256 !== binarySha256 ||
      lifecycle.subject_sha256 !== subjectSha256 ||
      lifecycle.bundle_sha256 !== bundleSha256
    ) {
      throw new Error(`${target.output} lifecycle evidence is stale or mislabeled`);
    }

    await Promise.all([
      verifySigstoreBundle(
        join(directory, `${target.output}.provenance.sigstore.json`),
        {
          name: target.output,
          sha256: binarySha256,
          predicateType: BUILD_PROVENANCE_PREDICATE,
        },
      ),
      verifySigstoreBundle(
        join(directory, `${target.output}.sbom.sigstore.json`),
        {
          name: target.output,
          sha256: binarySha256,
          predicateType: SPDX_SBOM_PREDICATE,
        },
      ),
    ]);
  }
}

if (import.meta.main) {
  const [directory, tag, sourceCommit, sourceDateEpoch, ...unexpected] =
    process.argv.slice(2);
  if (
    !directory ||
    !tag ||
    !sourceCommit ||
    !sourceDateEpoch ||
    unexpected.length > 0
  ) {
    throw new Error(
      "Usage: bun run scripts/check-release-assets.ts DIRECTORY TAG SOURCE_COMMIT SOURCE_DATE_EPOCH",
    );
  }
  await verifyReleaseAssets(directory, tag, sourceCommit, sourceDateEpoch);
  process.stdout.write(
    `Release assets verified: ${RELEASE_TARGETS.length} targets with checksums, lifecycle, SPDX and Sigstore subjects\n`,
  );
}
