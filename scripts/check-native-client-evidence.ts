import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  canonicalSkillSha256,
  clientEvalSubjectSha256,
  integrationBundleSha256,
} from "./client-eval-contract";
import { nativeClientDiscoveryEvidenceSchema } from "./native-client-discovery";

const projectRoot = resolve(import.meta.dir, "..");
const evidence = nativeClientDiscoveryEvidenceSchema.parse(
  JSON.parse(
    await readFile(
      resolve(projectRoot, "evidence/client-adapters/opencode.json"),
      "utf8",
    ),
  ) as unknown,
);
if (evidence.subject_sha256 !== await clientEvalSubjectSha256()) {
  throw new Error("OpenCode native discovery evidence is stale for the evaluated source");
}
if (evidence.bundle_sha256 !== integrationBundleSha256()) {
  throw new Error("OpenCode native discovery evidence has a stale integration bundle");
}
if (evidence.skill_sha256 !== canonicalSkillSha256()) {
  throw new Error("OpenCode native discovery evidence has a stale skill");
}

process.stdout.write("Native OpenCode discovery evidence verified\n");
