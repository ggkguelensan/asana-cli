import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  canonicalSkillSha256,
  clientEvalSubjectSha256,
  integrationBundleSha256,
} from "./client-eval-contract";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const nativeClientDiscoveryEvidenceSchema = z.strictObject({
  schema: z.literal("asana-cli.native-client-discovery.v1"),
  client: z.literal("opencode"),
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
    root: z.literal(".opencode/skills/asana"),
    state: z.literal("managed"),
  }),
  discovery: z.strictObject({
    command: z.literal("opencode --pure debug skill"),
    skill_name: z.literal("asana"),
    skill_reported: z.literal(true),
    skill_location_suffix: z.literal(".opencode/skills/asana/SKILL.md"),
  }),
  verdict: z.literal("passed"),
});
export type NativeClientDiscoveryEvidence = z.output<
  typeof nativeClientDiscoveryEvidenceSchema
>;

const discoveredSkillSchema = z.looseObject({
  name: z.string(),
  description: z.string(),
  location: z.string(),
  content: z.string(),
});

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function nativeDiscoveryContractSha256(): Promise<string> {
  const scriptNames = [
    "native-client-discovery.ts",
    "gemini-native-discovery.ts",
    "check-native-client-evidence.ts",
    "generate-gemini-extension.ts",
    "check-gemini-extension.ts",
  ] as const;
  const hash = createHash("sha256");
  for (const name of scriptNames) {
    const content = await readFile(resolve(import.meta.dir, name));
    hash.update(`${name.length}:${name}:${content.byteLength}:`, "utf8");
    hash.update(content);
  }
  return hash.digest("hex");
}

async function run(
  command: readonly string[],
  options: Readonly<{ cwd: string; environment: Readonly<Record<string, string>> }>,
): Promise<string> {
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
    throw new Error(`Native discovery command failed with exit code ${exitCode}: ${stderr}`);
  }
  return stdout;
}

export async function runOpenCodeDiscovery(
  executable: string,
  binary: string,
): Promise<NativeClientDiscoveryEvidence> {
  const temporary = await mkdtemp(join(tmpdir(), "asana-cli-opencode-discovery-"));
  try {
    const home = join(temporary, "home");
    const project = join(temporary, "project");
    await Promise.all([mkdir(home), mkdir(project)]);
    const environment = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_CACHE_HOME: join(home, ".cache"),
      ASANA_ACCESS_TOKEN: "",
      ASANA_PAT: "",
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      GEMINI_API_KEY: "",
      GOOGLE_GENERATIVE_AI_API_KEY: "",
    };
    const installOutput = await run([
      binary,
      "integrations",
      "install",
      "--client",
      "opencode",
      "--scope",
      "project",
      "--apply",
    ], { cwd: project, environment });
    const install = z.looseObject({
      execution: z.looseObject({ action: z.literal("install") }),
    }).parse(JSON.parse(installOutput) as unknown);
    if (install.execution.action !== "install") {
      throw new Error("OpenCode adapter did not install");
    }

    const discoveryOutput = await run(
      [executable, "--pure", "debug", "skill"],
      { cwd: project, environment },
    );
    const discovered = z.array(discoveredSkillSchema).parse(
      JSON.parse(discoveryOutput) as unknown,
    );
    const asana = discovered.find((skill) => skill.name === "asana");
    if (
      !asana ||
      !asana.location.split("\\").join("/").endsWith(".opencode/skills/asana/SKILL.md") ||
      !asana.content.includes("Use this skill only through curated `asana-cli agent` actions.")
    ) {
      throw new Error("OpenCode did not discover the installed Asana skill");
    }

    const clientVersion = (await run([executable, "--version"], {
      cwd: project,
      environment,
    })).trim();
    const [evaluatedCommit, contractSha256, subjectSha256, binaryBytes] = await Promise.all([
      run(["git", "rev-parse", "HEAD"], { cwd: resolve(import.meta.dir, ".."), environment }),
      nativeDiscoveryContractSha256(),
      clientEvalSubjectSha256(),
      readFile(binary),
    ]);
    return nativeClientDiscoveryEvidenceSchema.parse({
      schema: "asana-cli.native-client-discovery.v1",
      client: "opencode",
      client_version: clientVersion,
      evaluated_commit: evaluatedCommit.trim(),
      contract_sha256: contractSha256,
      subject_sha256: subjectSha256,
      bundle_sha256: integrationBundleSha256(),
      skill_sha256: canonicalSkillSha256(),
      binary_sha256: sha256(binaryBytes),
      discovery_output_sha256: sha256(JSON.stringify({
        name: asana.name,
        description: asana.description,
        location_suffix: ".opencode/skills/asana/SKILL.md",
        content_sha256: sha256(asana.content),
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
        root: ".opencode/skills/asana",
        state: "managed",
      },
      discovery: {
        command: "opencode --pure debug skill",
        skill_name: "asana",
        skill_reported: true,
        skill_location_suffix: ".opencode/skills/asana/SKILL.md",
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
      "Usage: native-client-discovery.ts --executable PATH --binary PATH --output FILE",
    );
  }
  const evidence = await runOpenCodeDiscovery(
    executable.includes("/") ? resolve(process.cwd(), executable) : executable,
    resolve(process.cwd(), binary),
  );
  const outputPath = resolve(process.cwd(), output);
  await mkdir(dirname(outputPath), { recursive: true });
  await Bun.write(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`OpenCode native discovery passed with ${evidence.client_version}\n`);
}

if (import.meta.main) await main();
