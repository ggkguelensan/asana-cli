import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  canonicalSkillSha256,
  clientEvalSubjectSha256,
  integrationBundleSha256,
} from "./client-eval-contract";
import {
  nativeClientDiscoveryEvidenceSchema,
  nativeDiscoveryContractSha256,
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
const subjectSha256 = await clientEvalSubjectSha256();
const contractSha256 = await nativeDiscoveryContractSha256();
for (const evidence of records) {
  if (evidence.contract_sha256 !== contractSha256) {
    throw new Error(`${evidence.client} native discovery evidence has a stale contract`);
  }
  if (evidence.subject_sha256 !== subjectSha256) {
    throw new Error(`${evidence.client} native discovery evidence is stale for the evaluated source`);
  }
  if (evidence.bundle_sha256 !== integrationBundleSha256()) {
    throw new Error(`${evidence.client} native discovery evidence has a stale integration bundle`);
  }
  if (evidence.skill_sha256 !== canonicalSkillSha256()) {
    throw new Error(`${evidence.client} native discovery evidence has a stale skill`);
  }
}

process.stdout.write(`Native client discovery evidence verified: ${records.length} clients\n`);
