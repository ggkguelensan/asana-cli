import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { SUPPORTED_RUNTIME_PLATFORMS } from "../src/platform-support";

const projectRoot = resolve(import.meta.dir, "..");

export const supportedBuildTargetSchema = z.enum([
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-arm64",
  "bun-linux-x64-baseline",
  "bun-linux-arm64-musl",
  "bun-linux-x64-baseline-musl",
]);

export type SupportedBuildTarget = z.output<typeof supportedBuildTargetSchema>;

const releaseTargetSchema = z.strictObject({
  target: supportedBuildTargetSchema,
  output: z.string().regex(/^asana-cli-(?:darwin|linux)-[a-z0-9-]+$/),
  runner: z.string().min(1),
});

export type ReleaseTarget = z.output<typeof releaseTargetSchema>;

export const RELEASE_TARGETS = Object.freeze([
  {
    target: "bun-darwin-arm64",
    output: "asana-cli-darwin-arm64",
    runner: "macos-14",
  },
  {
    target: "bun-darwin-x64",
    output: "asana-cli-darwin-x64",
    runner: "macos-15-intel",
  },
  {
    target: "bun-linux-arm64",
    output: "asana-cli-linux-arm64",
    runner: "ubuntu-24.04-arm",
  },
  {
    target: "bun-linux-x64-baseline",
    output: "asana-cli-linux-x64",
    runner: "ubuntu-latest",
  },
  {
    target: "bun-linux-arm64-musl",
    output: "asana-cli-linux-arm64-musl",
    runner: "ubuntu-24.04-arm",
  },
  {
    target: "bun-linux-x64-baseline-musl",
    output: "asana-cli-linux-x64-musl",
    runner: "ubuntu-latest",
  },
] as const satisfies readonly ReleaseTarget[]);

const packageSchema = z.looseObject({
  scripts: z.record(z.string(), z.string()),
});

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  throw new Error("Support matrix values must be JSON-compatible");
}

export function parseRequestedBuildTarget(
  rawTarget: string | undefined,
): SupportedBuildTarget | undefined {
  return rawTarget === undefined ? undefined : supportedBuildTargetSchema.parse(rawTarget);
}

export function extractReleaseTargets(workflow: string): readonly ReleaseTarget[] {
  const targets: ReleaseTarget[] = [];
  const pattern = /^\s+- target:\s*(\S+)\s*\n\s+output:\s*(\S+)\s*\n\s+runner:\s*(\S+)\s*$/gm;
  for (const match of workflow.matchAll(pattern)) {
    targets.push(releaseTargetSchema.parse({
      target: match[1],
      output: match[2],
      runner: match[3],
    }));
  }
  return targets;
}

export function verifySupportMatrix(input: Readonly<{
  packageJson: unknown;
  ciWorkflow: string;
  releaseWorkflow: string;
  supportPolicy: string;
}>): void {
  const packageJson = packageSchema.parse(input.packageJson);
  const windowsPattern = /windows|win32|powershell/i;

  if (stableJson(SUPPORTED_RUNTIME_PLATFORMS) !== stableJson(["darwin", "linux"])) {
    throw new Error("Runtime platform allowlist must contain exactly macOS and Linux");
  }

  const packageWindowsEntries = Object.entries(packageJson.scripts)
    .filter(([name, command]) => windowsPattern.test(name) || windowsPattern.test(command));
  if (packageWindowsEntries.length > 0) {
    throw new Error("package.json exposes a native Windows build command");
  }

  for (const releaseTarget of RELEASE_TARGETS) {
    const scriptName = `build:${releaseTarget.output.replace(/^asana-cli-/, "")}`;
    const expected = `bun run --no-env-file scripts/build.ts ${releaseTarget.target} dist/${releaseTarget.output}`;
    if (packageJson.scripts[scriptName] !== expected) {
      throw new Error(`package.json is missing the exact supported build script ${scriptName}`);
    }
  }

  if (windowsPattern.test(input.ciWorkflow)) {
    throw new Error("CI workflow contains a native Windows gate");
  }
  if (windowsPattern.test(input.releaseWorkflow)) {
    throw new Error("Release workflow contains a native Windows target or gate");
  }

  const actualTargets = extractReleaseTargets(input.releaseWorkflow);
  if (stableJson(actualTargets) !== stableJson(RELEASE_TARGETS)) {
    throw new Error("Release workflow matrix does not exactly match the supported target matrix");
  }

  if (!/^\s+needs:\s+build\s*$/m.test(input.releaseWorkflow)) {
    throw new Error("Release publish job must depend on the complete supported build matrix");
  }

  for (const releaseTarget of RELEASE_TARGETS) {
    if (!input.supportPolicy.includes(`\`${releaseTarget.output}\``)) {
      throw new Error(`Platform support policy does not document ${releaseTarget.output}`);
    }
  }
  if (/`asana-cli-windows[^`]*`/i.test(input.supportPolicy)) {
    throw new Error("Platform support policy documents a native Windows release artifact");
  }
}

async function main(): Promise<void> {
  const [packageText, ciWorkflow, releaseWorkflow, supportPolicy] = await Promise.all([
    readFile(resolve(projectRoot, "package.json"), "utf8"),
    readFile(resolve(projectRoot, ".github/workflows/ci.yml"), "utf8"),
    readFile(resolve(projectRoot, ".github/workflows/release.yml"), "utf8"),
    readFile(resolve(projectRoot, "docs/support-policy.md"), "utf8"),
  ]);
  verifySupportMatrix({
    packageJson: JSON.parse(packageText) as unknown,
    ciWorkflow,
    releaseWorkflow,
    supportPolicy,
  });
  process.stdout.write(
    `Support matrix verified: ${RELEASE_TARGETS.length} macOS/Linux release targets; native Windows excluded\n`,
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown support matrix failure";
    process.stderr.write(`Support matrix check failed: ${message}\n`);
    process.exit(1);
  }
}
