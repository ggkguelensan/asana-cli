import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

const projectRoot = resolve(import.meta.dir, "..");
const packageSchema = z.looseObject({
  scripts: z.record(z.string(), z.string()),
});

function count(text: string, fragment: string): number {
  return text.split(fragment).length - 1;
}

export function verifyReleaseWorkflow(
  workflow: string,
  packageValue: unknown,
): void {
  const packageJson = packageSchema.parse(packageValue);
  const requiredScripts = {
    "generate:release-sbom": "bun run --no-env-file scripts/release-sbom.ts",
    "generate:homebrew-formula": "bun run --no-env-file scripts/homebrew-formula.ts",
    "generate:release-checksums": "bun run --no-env-file scripts/release-assets.ts",
    "generate:reproducible-build": "bun run --no-env-file scripts/reproducible-build.ts",
    "generate:release-evidence": "bun run --no-env-file scripts/release-evidence-manifest.ts",
    "check:release-sbom": "bun run --no-env-file scripts/check-release-sbom.ts",
    "check:release-assets": "bun run --no-env-file scripts/check-release-assets.ts",
    "release:contract": "bun run --no-env-file scripts/release-contract.ts",
  } as const;
  for (const [name, command] of Object.entries(requiredScripts)) {
    if (packageJson.scripts[name] !== command) {
      throw new Error(`package.json is missing the exact release script ${name}`);
    }
  }

  if (
    count(workflow, "id-token: write") < 2 ||
    count(workflow, "attestations: write") < 2
  ) {
    throw new Error("Build and publish jobs must both receive attestation permissions");
  }
  if (count(workflow, "uses: actions/attest@v4") !== 3) {
    throw new Error("Release workflow must attest provenance, SBOM, and signed checksums");
  }

  const requiredFragments = [
    "scripts/release-sbom.ts",
    "scripts/check-release-sbom.ts",
    "bun run release:contract",
    "scripts/reproducible-build.ts",
    "dist/${{ matrix.output }}.reproducibility.json",
    "sbom-path: dist/${{ matrix.output }}.spdx.json",
    "dist/${{ matrix.output }}.provenance.sigstore.json",
    "dist/${{ matrix.output }}.sbom.sigstore.json",
    "bun run generate:homebrew-formula",
    "bun run generate:release-evidence",
    "dist/release-evidence.json",
    "bun run generate:release-checksums",
    "bun run check:release-assets",
    "gh attestation verify \"dist/$artifact\"",
    "--signer-workflow \"$GITHUB_REPOSITORY/.github/workflows/release.yml\"",
    "--source-digest \"$GITHUB_SHA\"",
    "--source-ref \"$GITHUB_REF\"",
    "--deny-self-hosted-runners",
    "--predicate-type https://spdx.dev/Document/v2.3",
    "subject-path: dist/SHA256SUMS",
    "dist/SHA256SUMS.sigstore.json",
    "gh attestation verify dist/SHA256SUMS",
  ];
  for (const fragment of requiredFragments) {
    if (!workflow.includes(fragment)) {
      throw new Error(`Release workflow is missing supply-chain gate: ${fragment}`);
    }
  }
  if (workflow.includes("sha256sum *")) {
    throw new Error("Release workflow must not checksum an unvalidated wildcard payload set");
  }
  if (count(workflow, '--user "$(id -u):$(id -g)"') !== 3) {
    throw new Error("Musl container gates must run as the GitHub runner UID/GID");
  }
  if (!/^\s+needs:\s+build\s*$/m.test(workflow)) {
    throw new Error("Release publish job must depend on the complete build matrix");
  }
}

async function main(): Promise<void> {
  const [workflow, packageValue] = await Promise.all([
    readFile(resolve(projectRoot, ".github/workflows/release.yml"), "utf8"),
    Bun.file(resolve(projectRoot, "package.json")).json() as Promise<unknown>,
  ]);
  verifyReleaseWorkflow(workflow, packageValue);
  process.stdout.write(
    "Release workflow verified: SPDX, provenance, signed checksums, contract gate and Homebrew\n",
  );
}

if (import.meta.main) {
  await main();
}
