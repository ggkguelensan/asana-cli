import { resolve } from "node:path";

export type QualityGateProfile = "fast" | "ci" | "release";

export type QualityGateStep = Readonly<{
  name: string;
  command: readonly string[];
}>;

export type QualityGateResult = Readonly<{
  exitCode: number;
}>;

export type QualityGateExecutor = (
  command: readonly string[],
) => Promise<QualityGateResult>;

const typecheck: QualityGateStep = {
  name: "typecheck",
  command: ["bun", "run", "typecheck"],
};
const generatedIntegrations: QualityGateStep = {
  name: "generated integrations",
  command: ["bun", "run", "check:generated-integrations"],
};
const clientCompatibility: QualityGateStep = {
  name: "client compatibility",
  command: ["bun", "run", "check:client-compatibility"],
};
const geminiExtension: QualityGateStep = {
  name: "Gemini extension",
  command: ["bun", "run", "check:gemini-extension"],
};
const projectPlan: QualityGateStep = {
  name: "project plan",
  command: ["bun", "run", "check:project-plan"],
};
const supportMatrix: QualityGateStep = {
  name: "support matrix",
  command: ["bun", "run", "check:support-matrix"],
};
const build: QualityGateStep = {
  name: "build",
  command: ["bun", "run", "build"],
};
const tests: QualityGateStep = {
  name: "tests",
  command: ["bun", "test"],
};
const version: QualityGateStep = {
  name: "compiled version",
  command: ["./dist/asana-cli", "--version"],
};

const fastSteps: readonly QualityGateStep[] = Object.freeze([
  typecheck,
  generatedIntegrations,
  clientCompatibility,
  geminiExtension,
  projectPlan,
  supportMatrix,
  build,
  tests,
  version,
]);

const ciSteps: readonly QualityGateStep[] = Object.freeze([
  typecheck,
  generatedIntegrations,
  clientCompatibility,
  geminiExtension,
  projectPlan,
  {
    name: "v1 completion audit",
    command: ["bun", "run", "check:v1-audit"],
  },
  supportMatrix,
  {
    name: "release workflow",
    command: ["bun", "run", "check:release-workflow"],
  },
  {
    name: "client evidence",
    command: ["bun", "run", "check:client-evidence"],
  },
  {
    name: "native client evidence",
    command: ["bun", "run", "check:native-client-evidence"],
  },
  {
    name: "integration lifecycle evidence",
    command: ["bun", "run", "check:integration-lifecycle-evidence"],
  },
  build,
  {
    name: "package content",
    command: ["bun", "run", "check:package-content"],
  },
  {
    name: "v1 examples",
    command: ["bun", "run", "check:v1-examples"],
  },
  tests,
  version,
]);

const releaseSteps: readonly QualityGateStep[] = Object.freeze([
  ...ciSteps,
  {
    name: "release compatibility contract",
    command: ["bun", "run", "release:contract", "--", "dist/asana-cli"],
  },
]);

export function qualityGateSteps(
  profile: QualityGateProfile,
): readonly QualityGateStep[] {
  if (profile === "fast") return fastSteps;
  if (profile === "ci") return ciSteps;
  return releaseSteps;
}

async function execute(command: readonly string[]): Promise<QualityGateResult> {
  const child = Bun.spawn([...command], {
    cwd: resolve(import.meta.dir, ".."),
    env: process.env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  return { exitCode: await child.exited };
}

export async function runQualityGate(
  profile: QualityGateProfile,
  executor: QualityGateExecutor = execute,
): Promise<void> {
  const steps = qualityGateSteps(profile);
  const gateStartedAt = performance.now();
  for (const [index, step] of steps.entries()) {
    const startedAt = performance.now();
    process.stdout.write(
      `\n[quality-gate ${index + 1}/${steps.length}] ${step.name}\n`,
    );
    const result = await executor(step.command);
    const seconds = ((performance.now() - startedAt) / 1_000).toFixed(2);
    if (result.exitCode !== 0) {
      throw new Error(
        `Quality gate failed at ${step.name} after ${seconds}s: ${step.command.join(" ")}`,
      );
    }
    process.stdout.write(`[quality-gate] ${step.name} passed in ${seconds}s\n`);
  }
  const seconds = ((performance.now() - gateStartedAt) / 1_000).toFixed(2);
  process.stdout.write(
    `\nQuality gate ${profile} passed: ${steps.length} steps in ${seconds}s\n`,
  );
}

function parseProfile(arguments_: readonly string[]): QualityGateProfile {
  const [profile, ...unexpected] = arguments_;
  if (
    unexpected.length > 0 ||
    (profile !== "fast" && profile !== "ci" && profile !== "release")
  ) {
    throw new Error("Usage: bun run scripts/quality-gate.ts fast|ci|release");
  }
  return profile;
}

if (import.meta.main) {
  await runQualityGate(parseProfile(process.argv.slice(2)));
}
