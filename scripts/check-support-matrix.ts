import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
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

export type ProductionSource = Readonly<{
  path: string;
  content: string;
}>;

const nativeWindowsSourcePattern = /\bwindows\b|\bwin32\b|localappdata|powershell|systemroot|\bwindir\b/i;
const nativeWindowsFilePattern = /windows|\.ps1$/i;

export function verifyPosixOnlyProductionSources(
  sources: readonly ProductionSource[],
): void {
  for (const source of sources) {
    if (
      nativeWindowsFilePattern.test(source.path) ||
      nativeWindowsSourcePattern.test(source.content)
    ) {
      throw new Error(
        `Production source contains a native Windows implementation: ${source.path}`,
      );
    }
  }
}

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
  if (
    !input.ciWorkflow.includes("native-integration-lifecycle:") ||
    !input.ciWorkflow.includes("runner: [ubuntu-latest, macos-14]") ||
    !input.ciWorkflow.includes("bun run test:integration-lifecycle")
  ) {
    throw new Error("CI must run the compiled integration lifecycle on native macOS and Linux");
  }
  if (
    !input.releaseWorkflow.includes("scripts/integration-lifecycle-e2e.ts") ||
    !input.releaseWorkflow.includes(
      '"${{ matrix.target }}" --output "dist/${{ matrix.output }}.lifecycle.json"',
    )
  ) {
    throw new Error("Every release target must publish compiled integration lifecycle evidence");
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
  const [packageText, ciWorkflow, releaseWorkflow, supportPolicy, productionSources] = await Promise.all([
    readFile(resolve(projectRoot, "package.json"), "utf8"),
    readFile(resolve(projectRoot, ".github/workflows/ci.yml"), "utf8"),
    readFile(resolve(projectRoot, ".github/workflows/release.yml"), "utf8"),
    readFile(resolve(projectRoot, "docs/support-policy.md"), "utf8"),
    readProductionSources(),
  ]);
  verifySupportMatrix({
    packageJson: JSON.parse(packageText) as unknown,
    ciWorkflow,
    releaseWorkflow,
    supportPolicy,
  });
  verifyPosixOnlyProductionSources(productionSources);
  process.stdout.write(
    `Support matrix verified: ${RELEASE_TARGETS.length} macOS/Linux release targets; production sources are POSIX-only\n`,
  );
}

async function readProductionSources(): Promise<readonly ProductionSource[]> {
  const sources: ProductionSource[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error: unknown) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        sources.push({
          path: relative(projectRoot, path),
          content: await readFile(path, "utf8"),
        });
      }
    }
  };
  await visit(resolve(projectRoot, "src"));
  await visit(resolve(projectRoot, "assets"));
  return sources;
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
