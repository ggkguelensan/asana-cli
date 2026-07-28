import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  canonicalSkillSha256,
} from "./client-eval-contract";
import {
  nativeClientDiscoveryEvidenceSchema,
} from "./native-client-discovery";
import { geminiNativeDiscoveryEvidenceSchema } from "./gemini-native-discovery";
import { copilotNativeDiscoveryEvidenceSchema } from "./copilot-native-discovery";

const projectRoot = resolve(import.meta.dir, "..");
const records = [
  nativeClientDiscoveryEvidenceSchema.parse(
    JSON.parse(
      await readFile(
        resolve(projectRoot, "evidence/client-adapters/opencode.json"),
        "utf8",
      ),
    ) as unknown,
  ),
  geminiNativeDiscoveryEvidenceSchema.parse(
    JSON.parse(
      await readFile(
        resolve(projectRoot, "evidence/client-adapters/gemini-cli.json"),
        "utf8",
      ),
    ) as unknown,
  ),
  copilotNativeDiscoveryEvidenceSchema.parse(
    JSON.parse(
      await readFile(
        resolve(projectRoot, "evidence/client-adapters/github-copilot.json"),
        "utf8",
      ),
    ) as unknown,
  ),
] as const;
const baseline = records[0];
for (const evidence of records) {
  if (
    evidence.contract_sha256 !== baseline.contract_sha256 ||
    evidence.subject_sha256 !== baseline.subject_sha256 ||
    evidence.bundle_sha256 !== baseline.bundle_sha256
  ) {
    throw new Error(`${evidence.client} native discovery evidence belongs to a different set`);
  }
  if (evidence.skill_sha256 !== canonicalSkillSha256()) {
    throw new Error(`${evidence.client} native discovery evidence does not cover the current primary skill`);
  }
}

process.stdout.write(
  `Archived primary-skill native discovery evidence verified: ${records.length} clients\n`,
);
