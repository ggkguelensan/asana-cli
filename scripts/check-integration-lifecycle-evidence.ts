import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { z } from "zod";
import { integrationBundleSha256, clientEvalSubjectSha256 } from "./client-eval-contract";
import { RELEASE_TARGETS } from "./check-support-matrix";
import { integrationLifecycleEvidenceSchema } from "./integration-lifecycle-e2e";

type IntegrationLifecycleEvidence = z.output<typeof integrationLifecycleEvidenceSchema>;

export async function verifyIntegrationLifecycleEvidence(
  records: Readonly<Record<string, unknown>>,
): Promise<void> {
  const subjectSha256 = await clientEvalSubjectSha256();
  const bundleSha256 = integrationBundleSha256();
  const binaryDigests = new Set<string>();
  for (const expected of RELEASE_TARGETS) {
    const evidence = integrationLifecycleEvidenceSchema.parse(records[expected.output]);
    if (evidence.target !== expected.target) {
      throw new Error(`${expected.output} lifecycle evidence has the wrong target`);
    }
    if (evidence.subject_sha256 !== subjectSha256) {
      throw new Error(`${expected.output} lifecycle evidence is stale for the evaluated source`);
    }
    if (evidence.bundle_sha256 !== bundleSha256) {
      throw new Error(`${expected.output} lifecycle evidence has a stale integration bundle`);
    }
    binaryDigests.add(evidence.binary_sha256);
  }
  if (binaryDigests.size !== RELEASE_TARGETS.length) {
    throw new Error("Lifecycle evidence must identify one distinct binary per release target");
  }
  const unexpected = Object.keys(records).filter(
    (output) => !RELEASE_TARGETS.some((target) => target.output === output),
  );
  if (unexpected.length > 0) {
    throw new Error(`Unexpected integration lifecycle evidence: ${unexpected[0]}`);
  }
}

async function main(): Promise<void> {
  const projectRoot = resolve(import.meta.dir, "..");
  const records: Record<string, IntegrationLifecycleEvidence> = {};
  for (const target of RELEASE_TARGETS) {
    const file = resolve(
      projectRoot,
      "evidence",
      "integration-lifecycle",
      `${target.output}.json`,
    );
    records[target.output] = integrationLifecycleEvidenceSchema.parse(
      JSON.parse(await readFile(file, "utf8")) as unknown,
    );
  }
  await verifyIntegrationLifecycleEvidence(records);
  process.stdout.write(
    `Integration lifecycle evidence verified: ${RELEASE_TARGETS.length} release targets\n`,
  );
}

if (import.meta.main) {
  await main();
}

