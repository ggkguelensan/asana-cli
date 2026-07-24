import { access } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

const binaryPathSchema = z.string().min(1).refine(isAbsolute, {
  message: "Release contract binary path must be absolute",
});

export type ReleaseContractResult = Readonly<{
  exitCode: number;
}>;
export type ReleaseContractExecutor = (
  command: readonly string[],
) => Promise<ReleaseContractResult>;

export function releaseContractCommands(binaryPath: string): readonly (readonly string[])[] {
  const binary = binaryPathSchema.parse(binaryPath);
  return Object.freeze([
    ["bun", "run", "check:generated-integrations"],
    ["bun", "run", "check:client-compatibility"],
    ["bun", "run", "check:gemini-extension"],
    ["bun", "run", "check:v1-audit"],
    ["bun", "run", "check:support-matrix"],
    ["bun", "run", "check:release-workflow"],
    ["bun", "run", "check:client-evidence"],
    ["bun", "run", "check:native-client-evidence"],
    ["bun", "run", "check:integration-lifecycle-evidence"],
    ["bun", "run", "check:package-content", "--", binary],
    ["bun", "run", "--no-env-file", "scripts/check-v1-examples.ts", binary],
    [
      "bun",
      "test",
      "tests/agent-protocol.test.ts",
      "tests/agent-v02-compat.test.ts",
      "tests/client-eval-contract.test.ts",
      "tests/package-content.test.ts",
      "tests/security.test.ts",
    ],
  ].map((command) => Object.freeze(command)));
}

async function execute(command: readonly string[]): Promise<ReleaseContractResult> {
  const child = Bun.spawn([...command], {
    cwd: resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      ASANA_ACCESS_TOKEN: "",
      ASANA_PAT: "",
    },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  return { exitCode: await child.exited };
}

export async function runReleaseContract(
  binaryArgument: string,
  executor: ReleaseContractExecutor = execute,
): Promise<void> {
  const binary = resolve(binaryArgument);
  await access(binary);
  for (const command of releaseContractCommands(binary)) {
    const result = await executor(command);
    if (result.exitCode !== 0) {
      throw new Error(`Release contract failed: ${command.join(" ")}`);
    }
  }
}

if (import.meta.main) {
  const [binary, ...unexpected] = process.argv.slice(2);
  if (!binary || unexpected.length > 0) {
    throw new Error("Usage: bun run scripts/release-contract.ts BINARY");
  }
  await runReleaseContract(binary);
  process.stdout.write("Release compatibility contract passed\n");
}
