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
import {
  GENERATED_GEMINI_EXTENSION_ROOT,
  renderGeminiExtensionFiles,
} from "./generate-gemini-extension";
import { nativeDiscoveryContractSha256 } from "./native-client-discovery";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const geminiNativeDiscoveryEvidenceSchema = z.strictObject({
  schema: z.literal("asana-cli.native-client-discovery.v1"),
  client: z.literal("gemini-cli"),
  client_version: z.string().min(1).max(128),
  evaluated_commit: z.string().regex(/^[a-f0-9]{40}$/),
  contract_sha256: sha256Schema,
  subject_sha256: sha256Schema,
  bundle_sha256: sha256Schema,
  skill_sha256: sha256Schema,
  extension_sha256: sha256Schema,
  binary_sha256: sha256Schema,
  discovery_output_sha256: sha256Schema,
  environment: z.strictObject({
    platform: z.enum(["darwin", "linux"]),
    architecture: z.enum(["arm64", "x64"]),
    scope: z.literal("user"),
    user_configuration: z.literal(false),
    provider_credentials: z.literal(false),
    model_invoked: z.literal(false),
    external_commands_executed: z.literal(false),
  }),
  install: z.strictObject({
    root: z.literal(".gemini/extensions/asana-cli"),
    state: z.literal("enabled"),
    manifest_validated: z.literal(true),
    mcp_declared: z.literal(false),
  }),
  discovery: z.strictObject({
    command: z.literal("npx -y @google/gemini-cli@0.50.0 extensions list"),
    extension_name: z.literal("asana-cli"),
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
  options: Readonly<{
    cwd: string;
    environment: Readonly<Record<string, string>>;
    input?: string;
  }>,
): Promise<string> {
  const child = Bun.spawn({
    cmd: [...command],
    cwd: options.cwd,
    env: options.environment,
    stdin: options.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (
    options.input !== undefined &&
    child.stdin !== undefined &&
    typeof child.stdin !== "number"
  ) {
    child.stdin.write(options.input);
    child.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Gemini discovery command failed with exit code ${exitCode}: ${stderr}`);
  }
  return stdout;
}

function extensionSha256(files: Readonly<Record<string, string>>): string {
  const hash = createHash("sha256");
  for (const [path, content] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    hash.update(`${path.length}:${path}:${Buffer.byteLength(content, "utf8")}:`, "utf8");
    hash.update(content, "utf8");
  }
  return hash.digest("hex");
}

export async function runGeminiDiscovery(
  executable: string,
  binary: string,
): Promise<z.output<typeof geminiNativeDiscoveryEvidenceSchema>> {
  const temporary = await mkdtemp(join(tmpdir(), "asana-cli-gemini-discovery-"));
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
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      GEMINI_API_KEY: "",
      GOOGLE_GENERATIVE_AI_API_KEY: "",
    };
    const gemini = [
      executable,
      "-y",
      "@google/gemini-cli@0.50.0",
    ] as const;
    const validation = await run([
      ...gemini,
      "extensions",
      "validate",
      GENERATED_GEMINI_EXTENSION_ROOT,
    ], { cwd: project, environment });
    if (!validation.includes("successfully validated")) {
      throw new Error("Gemini CLI did not validate the generated extension");
    }
    const installation = await run([
      ...gemini,
      "extensions",
      "install",
      GENERATED_GEMINI_EXTENSION_ROOT,
    ], {
      cwd: project,
      environment,
      input: "y\ny\ny\n",
    });
    if (!installation.includes('Extension "asana-cli" installed successfully and enabled.')) {
      throw new Error("Gemini CLI did not install the generated extension");
    }
    const listing = await run([
      ...gemini,
      "extensions",
      "list",
    ], { cwd: project, environment });
    if (
      !listing.includes("asana-cli (0.4.0)") ||
      !listing.includes("Agent skills:") ||
      !listing.includes("asana: Safely inspect assigned Asana work")
    ) {
      throw new Error("Gemini CLI did not report the installed Asana skill");
    }
    const clientVersion = (await run([...gemini, "--version"], {
      cwd: project,
      environment,
    })).trim();
    const [evaluatedCommit, contractSha256, subjectSha256, binaryBytes, extensionFiles] =
      await Promise.all([
        run(["git", "rev-parse", "HEAD"], {
          cwd: resolve(import.meta.dir, ".."),
          environment,
        }),
        nativeDiscoveryContractSha256(),
        clientEvalSubjectSha256(),
        readFile(binary),
        renderGeminiExtensionFiles(),
      ]);
    return geminiNativeDiscoveryEvidenceSchema.parse({
      schema: "asana-cli.native-client-discovery.v1",
      client: "gemini-cli",
      client_version: clientVersion,
      evaluated_commit: evaluatedCommit.trim(),
      contract_sha256: contractSha256,
      subject_sha256: subjectSha256,
      bundle_sha256: integrationBundleSha256(),
      skill_sha256: canonicalSkillSha256(),
      extension_sha256: extensionSha256(extensionFiles),
      binary_sha256: sha256(binaryBytes),
      discovery_output_sha256: sha256(JSON.stringify({
        extension_name: "asana-cli",
        extension_version: "0.4.0",
        extension_enabled: true,
        skill_name: "asana",
        skill_reported: true,
      })),
      environment: {
        platform: process.platform,
        architecture: process.arch,
        scope: "user",
        user_configuration: false,
        provider_credentials: false,
        model_invoked: false,
        external_commands_executed: false,
      },
      install: {
        root: ".gemini/extensions/asana-cli",
        state: "enabled",
        manifest_validated: true,
        mcp_declared: false,
      },
      discovery: {
        command: "npx -y @google/gemini-cli@0.50.0 extensions list",
        extension_name: "asana-cli",
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
      "Usage: gemini-native-discovery.ts --executable PATH --binary PATH --output FILE",
    );
  }
  const evidence = await runGeminiDiscovery(
    executable.includes("/") ? resolve(process.cwd(), executable) : executable,
    resolve(process.cwd(), binary),
  );
  const outputPath = resolve(process.cwd(), output);
  await mkdir(dirname(outputPath), { recursive: true });
  await Bun.write(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`Gemini native discovery passed with ${evidence.client_version}\n`);
}

if (import.meta.main) await main();
