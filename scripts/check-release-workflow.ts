import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export function verifyReleaseWorkflow(workflow: string): void {
  for (const required of [
    "bun install --frozen-lockfile", "bun run check", "bun run release:preflight",
    "scripts/release-sbom.ts", "scripts/check-release-sbom.ts", "scripts/reproducible-build.ts",
    "bun run check:package-content", "bun run check:release-assets", "gh attestation verify",
    "--predicate-type https://spdx.dev/Document/v2.3", "--deny-self-hosted-runners",
    "subject-path: dist/SHA256SUMS", "--draft", "--verify-tag",
  ]) {
    if (!workflow.includes(required)) throw new Error(`Release workflow is missing ${required}`);
  }
  if (/integration-lifecycle|client-evals|generate:integrations/.test(workflow)) {
    throw new Error("Release workflow depends on removed integrations");
  }
}
if (import.meta.main) {
  verifyReleaseWorkflow(await readFile(resolve(import.meta.dir, "../.github/workflows/release.yml"), "utf8"));
  console.log("Release workflow verified");
}
