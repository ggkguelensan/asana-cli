import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  canonicalSkillSha256,
  clientEvalContractSha256,
  clientEvalEvidenceSchema,
  clientEvalSubjectSha256,
  integrationBundleSha256,
  validateClientEvalResponse,
} from "./client-eval-contract";

const projectRoot = resolve(import.meta.dir, "..");
const evidenceFiles = [
  resolve(projectRoot, "evidence/client-evals/codex.json"),
  resolve(projectRoot, "evidence/client-evals/claude-code.json"),
] as const;

const [subjectSha256, contractSha256] = await Promise.all([
  clientEvalSubjectSha256(),
  clientEvalContractSha256(),
]);

for (const file of evidenceFiles) {
  const evidence = clientEvalEvidenceSchema.parse(
    JSON.parse(await readFile(file, "utf8")) as unknown,
  );
  if (evidence.subject_sha256 !== subjectSha256) {
    throw new Error(`${evidence.client} client evidence is stale for the evaluated source`);
  }
  if (evidence.contract_sha256 !== contractSha256) {
    throw new Error(`${evidence.client} client evidence is stale for the eval contract`);
  }
  if (evidence.bundle_sha256 !== integrationBundleSha256()) {
    throw new Error(`${evidence.client} client evidence has a stale integration bundle`);
  }
  if (evidence.skill_sha256 !== canonicalSkillSha256()) {
    throw new Error(`${evidence.client} client evidence has a stale skill`);
  }
  validateClientEvalResponse(evidence.response);
}

process.stdout.write(`Client evidence verified: ${evidenceFiles.length} clients\n`);

