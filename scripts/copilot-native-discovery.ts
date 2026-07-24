import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import {
  canonicalSkillSha256,
  clientEvalSubjectSha256,
  integrationBundleSha256,
} from "./client-eval-contract";
import { nativeDiscoveryContractSha256 } from "./native-client-discovery";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const copilotNativeDiscoveryEvidenceSchema = z.strictObject({
  schema: z.literal("asana-cli.native-client-discovery.v1"),
  client: z.literal("github-copilot"),
  client_version: z.string().min(1).max(128),
  evaluated_commit: z.string().regex(/^[a-f0-9]{40}$/),
  contract_sha256: sha256Schema,
  subject_sha256: sha256Schema,
  bundle_sha256: sha256Schema,
  skill_sha256: sha256Schema,
  binary_sha256: sha256Schema,
  discovery_output_sha256: sha256Schema,
  environment: z.strictObject({
    platform: z.enum(["darwin", "linux"]),
    architecture: z.enum(["arm64", "x64"]),
    scope: z.literal("project"),
    user_configuration: z.literal(false),
    provider_credentials: z.literal(false),
    model_invoked: z.literal(false),
    external_commands_executed: z.literal(false),
  }),
  install: z.strictObject({
    root: z.literal(".github/skills/asana"),
    state: z.literal("managed"),
    allowed_tools_declared: z.literal(false),
  }),
  discovery: z.strictObject({
    command: z.literal(
      "npm exec --yes --package=@github/copilot@1.0.74 -- copilot skill list",
    ),
    skill_name: z.literal("asana"),
    skill_reported: z.literal(true),
  }),
  verdict: z.literal("passed"),
});

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function run(
  command: readonly string[],
  options: Readonly<{ cwd: string; environment: Readonly<Record<string, string>> }>,
): Promise<Readonly<{ stdout: string; stderr: string }>> {
  const child = Bun.spawn({
    cmd: [...command],
    cwd: options.cwd,
    env: options.environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Copilot discovery command failed with exit code ${exitCode}: ${stderr}`);
  }
  return { stdout, stderr };
}

export async function runCopilotDiscovery(
  executable: string,
  binary: string,
): Promise<z.output<typeof copilotNativeDiscoveryEvidenceSchema>> {
  const temporary = await mkdtemp(join(tmpdir(), "asana-cli-copilot-discovery-"));
  try {
    const home = join(temporary, "home");
    const project = join(temporary, "project");
    await Promise.all([mkdir(home), mkdir(project)]);
    const environment = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      npm_config_cache: join(temporary, "npm-cache"),
      ASANA_ACCESS_TOKEN: "",
      ASANA_PAT: "",
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
    };
    const installation = await run([
      binary,
      "integrations",
      "install",
      "--client",
      "github-copilot",
      "--scope",
      "project",
      "--apply",
    ], { cwd: project, environment });
    const installed = z.looseObject({
      execution: z.looseObject({ action: z.literal("install") }),
    }).parse(JSON.parse(installation.stdout) as unknown);
    if (installed.execution.action !== "install") {
      throw new Error("GitHub Copilot adapter did not install");
    }
    const skillText = await readFile(
      join(project, ".github", "skills", "asana", "SKILL.md"),
      "utf8",
    );
    if (skillText.includes("allowed-tools:")) {
      throw new Error("GitHub Copilot skill declares broad allowed-tools");
    }
    const copilot = [
      executable,
      "exec",
      "--yes",
      "--package=@github/copilot@1.0.74",
      "--",
      "copilot",
    ] as const;
    const listing = await run([...copilot, "skill", "list"], {
      cwd: project,
      environment,
    });
    if (
      !listing.stdout.includes("Project skills:") ||
      !listing.stdout.includes(
        "asana - Safely inspect assigned Asana work and prepare narrowly scoped task updates",
      )
    ) {
      throw new Error("GitHub Copilot CLI did not report the installed Asana skill");
    }
    const version = await run([...copilot, "--version"], {
      cwd: project,
      environment,
    });
    const clientVersion = version.stdout.match(/GitHub Copilot CLI ([0-9.]+)\./)?.[1];
    if (!clientVersion) throw new Error("GitHub Copilot CLI returned an unexpected version");
    const [evaluatedCommit, contractSha256, subjectSha256, binaryBytes] =
      await Promise.all([
        run(["git", "rev-parse", "HEAD"], {
          cwd: resolve(import.meta.dir, ".."),
          environment,
        }),
        nativeDiscoveryContractSha256(),
        clientEvalSubjectSha256(),
        readFile(binary),
      ]);
    return copilotNativeDiscoveryEvidenceSchema.parse({
      schema: "asana-cli.native-client-discovery.v1",
      client: "github-copilot",
      client_version: clientVersion,
      evaluated_commit: evaluatedCommit.stdout.trim(),
      contract_sha256: contractSha256,
      subject_sha256: subjectSha256,
      bundle_sha256: integrationBundleSha256(),
      skill_sha256: canonicalSkillSha256(),
      binary_sha256: sha256(binaryBytes),
      discovery_output_sha256: sha256(JSON.stringify({
        section: "Project skills",
        skill_name: "asana",
        skill_reported: true,
      })),
      environment: {
        platform: process.platform,
        architecture: process.arch,
        scope: "project",
        user_configuration: false,
        provider_credentials: false,
        model_invoked: false,
        external_commands_executed: false,
      },
      install: {
        root: ".github/skills/asana",
        state: "managed",
        allowed_tools_declared: false,
      },
      discovery: {
        command: "npm exec --yes --package=@github/copilot@1.0.74 -- copilot skill list",
        skill_name: "asana",
        skill_reported: true,
      },
      verdict: "passed",
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const executableIndex = args.indexOf("--executable");
  const binaryIndex = args.indexOf("--binary");
  const outputIndex = args.indexOf("--output");
  const executable = executableIndex >= 0 ? args[executableIndex + 1] : undefined;
  const binary = binaryIndex >= 0 ? args[binaryIndex + 1] : undefined;
  const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  if (!executable || !binary || !output || args.length !== 6) {
    throw new Error(
      "Usage: copilot-native-discovery.ts --executable PATH --binary PATH --output FILE",
    );
  }
  const evidence = await runCopilotDiscovery(
    executable.includes("/") ? resolve(process.cwd(), executable) : executable,
    resolve(process.cwd(), binary),
  );
  const outputPath = resolve(process.cwd(), output);
  await mkdir(dirname(outputPath), { recursive: true });
  await Bun.write(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`GitHub Copilot native discovery passed with ${evidence.client_version}\n`);
}

if (import.meta.main) await main();
