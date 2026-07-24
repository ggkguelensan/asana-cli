import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyIntegrationLifecycleEvidence } from "../scripts/check-integration-lifecycle-evidence";
import { RELEASE_TARGETS } from "../scripts/check-support-matrix";

const projectRoot = resolve(import.meta.dir, "..");

async function evidenceRecords(): Promise<Record<string, unknown>> {
  const entries = await Promise.all(RELEASE_TARGETS.map(async (target) => [
    target.output,
    JSON.parse(await readFile(
      resolve(projectRoot, "evidence/integration-lifecycle", `${target.output}.json`),
      "utf8",
    )) as unknown,
  ] as const));
  return Object.fromEntries(entries);
}

describe("saved native integration lifecycle evidence", () => {
  test("covers every canonical POSIX release target", async () => {
    await expect(verifyIntegrationLifecycleEvidence(await evidenceRecords())).resolves.toBeUndefined();
  });

  test("rejects missing, mislabeled, stale, duplicate, and unexpected records", async () => {
    const mutations = [
      (records: Record<string, unknown>) => {
        delete records[RELEASE_TARGETS[0]!.output];
      },
      (records: Record<string, unknown>) => {
        const record = records[RELEASE_TARGETS[0]!.output] as Record<string, unknown>;
        record.target = RELEASE_TARGETS[1]!.target;
      },
      (records: Record<string, unknown>) => {
        const record = records[RELEASE_TARGETS[0]!.output] as Record<string, unknown>;
        record.subject_sha256 = "0".repeat(64);
      },
      (records: Record<string, unknown>) => {
        const first = records[RELEASE_TARGETS[0]!.output] as Record<string, unknown>;
        const second = records[RELEASE_TARGETS[1]!.output] as Record<string, unknown>;
        second.binary_sha256 = first.binary_sha256;
      },
      (records: Record<string, unknown>) => {
        records.unexpected = records[RELEASE_TARGETS[0]!.output];
      },
    ];
    for (const mutate of mutations) {
      const records = await evidenceRecords();
      mutate(records);
      await expect(verifyIntegrationLifecycleEvidence(records)).rejects.toThrow();
    }
  });
});

