import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  RELEASE_TARGETS,
  supportedBuildTargetSchema,
  type SupportedBuildTarget,
} from "./check-support-matrix";

const projectRoot = resolve(import.meta.dir, "..");
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const gitCommitSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
const sourceDateEpochSchema = z.coerce.number().int().nonnegative();
const bunVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const artifactSchema = z.strictObject({
  name: z.string().regex(/^asana-cli-(?:darwin|linux)-[a-z0-9-]+$/),
  sha256: sha256Schema,
  size_bytes: z.number().int().positive(),
});

export const reproducibleBuildEvidenceSchema = z.strictObject({
  schema: z.literal("asana-cli.reproducible-build.v1"),
  target: supportedBuildTargetSchema,
  source_commit: gitCommitSchema,
  source_date_epoch: z.number().int().nonnegative(),
  bun_version: bunVersionSchema,
  lock_sha256: sha256Schema,
  build_recipe_sha256: sha256Schema,
  build_command: z.tuple([
    z.literal("bun"),
    z.literal("run"),
    z.literal("--no-env-file"),
    z.literal("scripts/build.ts"),
    supportedBuildTargetSchema,
    z.literal("<output>"),
  ]),
  reference: artifactSchema,
  rebuild: artifactSchema,
  comparison: z.literal("byte-identical"),
  normalized_differences: z.tuple([]),
});

export type ReproducibleBuildEvidence = z.output<typeof reproducibleBuildEvidenceSchema>;

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function targetOutput(target: SupportedBuildTarget): string {
  const releaseTarget = RELEASE_TARGETS.find((candidate) => candidate.target === target);
  if (!releaseTarget) throw new Error(`Missing release output for ${target}`);
  return releaseTarget.output;
}

async function buildRecipeSha256(): Promise<string> {
  const paths = [
    "scripts/build.ts",
    "scripts/check-support-matrix.ts",
    "package.json",
    "bun.lock",
  ] as const;
  const hash = createHash("sha256");
  for (const path of paths) {
    const bytes = await readFile(resolve(projectRoot, path));
    hash.update(`${path.length}:${path}:${bytes.byteLength}:`, "utf8");
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export async function createReproducibleBuildEvidence(input: Readonly<{
  target: SupportedBuildTarget;
  sourceCommit: string;
  sourceDateEpoch: number | string;
  bunVersion: string;
  lockText: string;
  buildRecipeSha256: string;
  artifactName: string;
  referenceBytes: Uint8Array;
  rebuildBytes: Uint8Array;
}>): Promise<ReproducibleBuildEvidence> {
  const target = supportedBuildTargetSchema.parse(input.target);
  const expectedName = targetOutput(target);
  if (input.artifactName !== expectedName) {
    throw new Error(`${target} reproducibility evidence must describe ${expectedName}`);
  }
  const referenceSha256 = sha256(input.referenceBytes);
  const rebuildSha256 = sha256(input.rebuildBytes);
  if (
    referenceSha256 !== rebuildSha256 ||
    input.referenceBytes.byteLength !== input.rebuildBytes.byteLength
  ) {
    throw new Error(
      `Reproducibility mismatch for ${target}: ${referenceSha256} != ${rebuildSha256}`,
    );
  }
  return reproducibleBuildEvidenceSchema.parse({
    schema: "asana-cli.reproducible-build.v1",
    target,
    source_commit: gitCommitSchema.parse(input.sourceCommit),
    source_date_epoch: sourceDateEpochSchema.parse(input.sourceDateEpoch),
    bun_version: bunVersionSchema.parse(input.bunVersion),
    lock_sha256: sha256(input.lockText),
    build_recipe_sha256: sha256Schema.parse(input.buildRecipeSha256),
    build_command: [
      "bun",
      "run",
      "--no-env-file",
      "scripts/build.ts",
      target,
      "<output>",
    ],
    reference: {
      name: input.artifactName,
      sha256: referenceSha256,
      size_bytes: input.referenceBytes.byteLength,
    },
    rebuild: {
      name: input.artifactName,
      sha256: rebuildSha256,
      size_bytes: input.rebuildBytes.byteLength,
    },
    comparison: "byte-identical",
    normalized_differences: [],
  });
}

export async function runReproducibleBuild(
  binaryArgument: string,
  rawTarget: string,
  sourceCommit: string,
  sourceDateEpoch: string | number,
  outputArgument: string,
): Promise<ReproducibleBuildEvidence> {
  const target = supportedBuildTargetSchema.parse(rawTarget);
  const binaryPath = resolve(binaryArgument);
  const artifactName = basename(binaryPath);
  const root = await mkdtemp(join(tmpdir(), "asana-cli-rebuild-"));
  try {
    const rebuildPath = join(root, artifactName);
    const child = Bun.spawn([
      "bun",
      "run",
      "--no-env-file",
      "scripts/build.ts",
      target,
      rebuildPath,
    ], {
      cwd: projectRoot,
      env: {
        ...process.env,
        SOURCE_DATE_EPOCH: String(sourceDateEpochSchema.parse(sourceDateEpoch)),
      },
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new Error(`Independent rebuild failed for ${target}`);
    const [referenceBytes, rebuildBytes, lockText, recipeSha256] = await Promise.all([
      readFile(binaryPath),
      readFile(rebuildPath),
      readFile(resolve(projectRoot, "bun.lock"), "utf8"),
      buildRecipeSha256(),
    ]);
    const evidence = await createReproducibleBuildEvidence({
      target,
      sourceCommit,
      sourceDateEpoch,
      bunVersion: Bun.version,
      lockText,
      buildRecipeSha256: recipeSha256,
      artifactName,
      referenceBytes,
      rebuildBytes,
    });
    const outputPath = resolve(outputArgument);
    await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    return evidence;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function verifyReproducibleBuildEvidence(
  binaryArgument: string,
  rawTarget: string,
  sourceCommit: string,
  sourceDateEpoch: string | number,
  evidenceArgument: string,
): Promise<ReproducibleBuildEvidence> {
  const target = supportedBuildTargetSchema.parse(rawTarget);
  const binaryPath = resolve(binaryArgument);
  const [binaryBytes, lockText, recipeSha256, evidenceText] = await Promise.all([
    readFile(binaryPath),
    readFile(resolve(projectRoot, "bun.lock"), "utf8"),
    buildRecipeSha256(),
    readFile(resolve(evidenceArgument), "utf8"),
  ]);
  const evidence = reproducibleBuildEvidenceSchema.parse(
    JSON.parse(evidenceText) as unknown,
  );
  const expectedSha256 = sha256(binaryBytes);
  if (
    evidence.target !== target ||
    evidence.source_commit !== gitCommitSchema.parse(sourceCommit) ||
    evidence.source_date_epoch !== sourceDateEpochSchema.parse(sourceDateEpoch) ||
    evidence.bun_version !== Bun.version ||
    evidence.lock_sha256 !== sha256(lockText) ||
    evidence.build_recipe_sha256 !== recipeSha256 ||
    evidence.reference.name !== basename(binaryPath) ||
    evidence.reference.sha256 !== expectedSha256 ||
    evidence.reference.size_bytes !== binaryBytes.byteLength ||
    evidence.rebuild.sha256 !== expectedSha256 ||
    evidence.rebuild.size_bytes !== binaryBytes.byteLength
  ) {
    throw new Error("Reproducibility evidence is stale or does not describe the selected build");
  }
  return evidence;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--output");
  const output = outputIndex === -1 ? undefined : args[outputIndex + 1];
  const positionals = outputIndex === -1
    ? args
    : args.filter((_, index) => index !== outputIndex && index !== outputIndex + 1);
  const [binary, target, sourceCommit, sourceDateEpoch, ...unexpected] = positionals;
  if (
    !binary ||
    !target ||
    !sourceCommit ||
    !sourceDateEpoch ||
    !output ||
    unexpected.length > 0 ||
    outputIndex + 2 !== args.length
  ) {
    throw new Error(
      "Usage: bun run scripts/reproducible-build.ts BINARY TARGET SOURCE_COMMIT SOURCE_DATE_EPOCH --output FILE",
    );
  }
  const evidence = await runReproducibleBuild(
    binary,
    target,
    sourceCommit,
    sourceDateEpoch,
    output,
  );
  process.stdout.write(
    `Reproducible build verified for ${evidence.target}: ${evidence.reference.sha256}\n`,
  );
}
