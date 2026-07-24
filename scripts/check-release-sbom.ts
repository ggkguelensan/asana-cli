import { basename, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { supportedBuildTargetSchema } from "./check-support-matrix";
import {
  buildReleaseSbom,
  releaseSbomSchema,
  type ReleaseSbom,
} from "./release-sbom";

const projectRoot = resolve(import.meta.dir, "..");

export async function verifyReleaseSbom(
  binaryPath: string,
  rawTarget: string,
  sourceCommit: string,
  sourceDateEpoch: string | number,
  sbomPath: string,
): Promise<ReleaseSbom> {
  const target = supportedBuildTargetSchema.parse(rawTarget);
  const [binaryBytes, lockText, packageValue, sbomText] = await Promise.all([
    readFile(binaryPath),
    readFile(resolve(projectRoot, "bun.lock"), "utf8"),
    Bun.file(resolve(projectRoot, "package.json")).json() as Promise<unknown>,
    readFile(sbomPath, "utf8"),
  ]);
  const actual = releaseSbomSchema.parse(JSON.parse(sbomText) as unknown);
  const expected = buildReleaseSbom({
    binaryName: basename(binaryPath),
    binaryBytes,
    target,
    sourceCommit,
    sourceDateEpoch,
    lockText,
    packageValue,
  });
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Release SBOM does not exactly describe the selected source and binary");
  }
  return actual;
}

if (import.meta.main) {
  const [binary, target, sourceCommit, sourceDateEpoch, sbom, ...unexpected] =
    process.argv.slice(2);
  if (
    !binary ||
    !target ||
    !sourceCommit ||
    !sourceDateEpoch ||
    !sbom ||
    unexpected.length > 0
  ) {
    throw new Error(
      "Usage: bun run scripts/check-release-sbom.ts BINARY TARGET SOURCE_COMMIT SOURCE_DATE_EPOCH SBOM",
    );
  }
  const verified = await verifyReleaseSbom(
    resolve(binary),
    target,
    sourceCommit,
    sourceDateEpoch,
    resolve(sbom),
  );
  process.stdout.write(
    `Release SBOM verified: ${verified.packages.length} packages describe ${verified.files[0].fileName}\n`,
  );
}
