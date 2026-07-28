import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { z } from "zod";
import {
  canonicalSkillSha256,
  clientEvalEvidenceSchema,
  validateClientEvalResponse,
} from "./client-eval-contract";

const projectRoot = resolve(import.meta.dir, "..");
const evidenceFiles = [
  resolve(projectRoot, "evidence/client-evals/codex.json"),
  resolve(projectRoot, "evidence/client-evals/claude-code.json"),
] as const;

let baseline: z.output<typeof clientEvalEvidenceSchema> | undefined;

for (const file of evidenceFiles) {
  const evidence = clientEvalEvidenceSchema.parse(
    JSON.parse(await readFile(file, "utf8")) as unknown,
  );
  baseline ??= evidence;
  if (
    evidence.subject_sha256 !== baseline.subject_sha256 ||
    evidence.contract_sha256 !== baseline.contract_sha256 ||
    evidence.bundle_sha256 !== baseline.bundle_sha256
  ) {
    throw new Error(`${evidence.client} client evidence belongs to a different evaluation set`);
  }
  if (evidence.skill_sha256 !== canonicalSkillSha256()) {
    throw new Error(`${evidence.client} client evidence does not cover the current primary skill`);
  }
  validateClientEvalResponse(evidence.response);
}

process.stdout.write(
  `Archived primary-skill client evidence verified: ${evidenceFiles.length} clients\n`,
);
