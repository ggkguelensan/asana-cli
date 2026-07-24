import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  CLIENT_EVAL_OUTPUT_JSON_SCHEMA,
  canonicalSkillSha256,
  clientEvalContractSha256,
  clientEvalEvidenceSchema,
  clientEvalIdSchema,
  clientEvalResponseSchema,
  clientEvalPrompt,
  clientEvalSubjectSha256,
  integrationBundleSha256,
  validateClientEvalResponse,
  type ClientEvalEvidence,
  type ClientEvalId,
} from "./client-eval-contract";

const projectRoot = resolve(import.meta.dir, "..");
const MAX_CLIENT_OUTPUT_BYTES = 2 * 1024 * 1024;

type ProcessResult = Readonly<{ stdout: string; exit_code: number }>;

function safeClientEnvironment(): Record<string, string> {
  const allowed = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "SHELL",
    "LANG",
    "LC_ALL",
    "TERM",
    "COLORTERM",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ] as const;
  const environment: Record<string, string> = {
    ASANA_ACCESS_TOKEN: "",
    ASANA_PAT: "",
  };
  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

async function runProcess(
  executable: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; env: Readonly<Record<string, string>> }>,
): Promise<ProcessResult> {
  const child = Bun.spawn([executable, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdoutBytes, stderrBytes, exitCode] = await Promise.all([
    new Response(child.stdout).bytes(),
    new Response(child.stderr).bytes(),
    child.exited,
  ]);
  if (stdoutBytes.byteLength > MAX_CLIENT_OUTPUT_BYTES || stderrBytes.byteLength > MAX_CLIENT_OUTPUT_BYTES) {
    throw new Error(`${basename(executable)} exceeded the bounded eval output size`);
  }
  if (exitCode !== 0) {
    throw new Error(`${basename(executable)} eval failed with exit ${exitCode}`);
  }
  return {
    stdout: new TextDecoder("utf-8", { fatal: true }).decode(stdoutBytes),
    exit_code: exitCode,
  };
}

async function clientVersion(executable: string, cwd: string): Promise<string> {
  const result = await runProcess(executable, ["--version"], {
    cwd,
    env: safeClientEnvironment(),
  });
  return z.string().trim().min(1).max(128).parse(result.stdout);
}

function parseJsonLines(output: string): readonly unknown[] {
  return output.split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as unknown);
}

function parseCodexResponse(output: string): Readonly<{
  response: unknown;
  model: string;
  registry_observed: boolean;
}> {
  const eventSchema = z.looseObject({
    type: z.string(),
    item: z.looseObject({
      type: z.string(),
      text: z.string().optional(),
    }).optional(),
  });
  const events = parseJsonLines(output).map((event) => eventSchema.parse(event));
  const prohibitedToolEvent = events.find((event) =>
    event.item !== undefined &&
    !["agent_message", "reasoning"].includes(event.item.type)
  );
  if (prohibitedToolEvent) {
    throw new Error("Codex eval attempted an external tool");
  }
  const messages = events
    .filter((event) => event.type === "item.completed" && event.item?.type === "agent_message")
    .map((event) => event.item?.text)
    .filter((text): text is string => text !== undefined);
  const message = messages.at(-1);
  if (!message) throw new Error("Codex eval did not return a final agent message");
  return {
    response: JSON.parse(message) as unknown,
    model: "client-default",
    registry_observed: false,
  };
}

function parseClaudeResponse(output: string): Readonly<{
  response: unknown;
  model: string;
  registry_observed: boolean;
}> {
  const events = parseJsonLines(output);
  const initSchema = z.looseObject({
    type: z.literal("system"),
    subtype: z.literal("init"),
    model: z.string().min(1),
    skills: z.array(z.string()),
    tools: z.array(z.string()),
  });
  const resultSchema = z.looseObject({
    type: z.literal("result"),
    subtype: z.literal("success"),
    result: z.string(),
  });
  const init = events.map((event) => initSchema.safeParse(event)).find((result) => result.success);
  const result = [...events].reverse()
    .map((event) => resultSchema.safeParse(event))
    .find((candidate) => candidate.success);
  if (!init?.success || !result?.success) throw new Error("Claude eval omitted init or result evidence");
  if (JSON.stringify(init.data.tools) !== JSON.stringify(["Skill"])) {
    throw new Error("Claude eval exposed a tool other than Skill");
  }
  return {
    response: JSON.parse(result.data.result) as unknown,
    model: init.data.model,
    registry_observed: init.data.skills.includes("asana"),
  };
}

async function installProjectSkill(
  binary: string,
  client: ClientEvalId,
  root: string,
): Promise<Readonly<{ home: string; project: string }>> {
  const home = join(root, "home");
  const project = join(root, "project");
  await Promise.all([
    mkdir(home, { recursive: true, mode: 0o700 }),
    mkdir(project, { recursive: true, mode: 0o700 }),
  ]);
  const result = await runProcess(binary, [
    "integrations",
    "install",
    "--client",
    client,
    "--scope",
    "project",
    "--apply",
  ], {
    cwd: project,
    env: {
      ...safeClientEnvironment(),
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_STATE_HOME: join(home, ".local", "state"),
    },
  });
  z.looseObject({
    execution: z.looseObject({ action: z.literal("install") }),
  }).parse(JSON.parse(result.stdout) as unknown);
  return { home, project };
}

async function evaluateClient(
  client: ClientEvalId,
  executable: string,
  project: string,
  schemaPath: string,
): Promise<Readonly<{
  version: string;
  model: string;
  registry_observed: boolean;
  transcript: string;
  response: unknown;
}>> {
  const version = await clientVersion(executable, project);
  const prompt = clientEvalPrompt();
  const environment = safeClientEnvironment();
  if (client === "codex") {
    const result = await runProcess(executable, [
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--cd",
      project,
      "--skip-git-repo-check",
      "--output-schema",
      schemaPath,
      "--json",
      "-c",
      "shell_environment_policy.inherit=none",
      prompt,
    ], { cwd: project, env: environment });
    const parsed = parseCodexResponse(result.stdout);
    return { version, transcript: result.stdout, ...parsed };
  }

  const result = await runProcess(executable, [
    "--print",
    "--no-session-persistence",
    "--setting-sources",
    "project",
    "--permission-mode",
    "dontAsk",
    "--tools",
    "Skill",
    "--output-format",
    "stream-json",
    "--verbose",
    "--json-schema",
    JSON.stringify(CLIENT_EVAL_OUTPUT_JSON_SCHEMA),
    "--max-budget-usd",
    "0.20",
    prompt,
  ], { cwd: project, env: environment });
  const parsed = parseClaudeResponse(result.stdout);
  return { version, transcript: result.stdout, ...parsed };
}

async function gitHead(): Promise<string> {
  const result = await runProcess("git", ["rev-parse", "HEAD"], {
    cwd: projectRoot,
    env: safeClientEnvironment(),
  });
  return z.string().trim().regex(/^[a-f0-9]{40}$/).parse(result.stdout);
}

export async function runClientEval(input: Readonly<{
  client: ClientEvalId;
  executable: string;
  binary: string;
}>): Promise<ClientEvalEvidence> {
  const binary = isAbsolute(input.binary) ? input.binary : resolve(input.binary);
  const executable = isAbsolute(input.executable)
    ? input.executable
    : Bun.which(input.executable);
  if (!executable) throw new Error(`Client executable is unavailable: ${input.executable}`);
  await chmod(binary, 0o755);
  const root = await mkdtemp(join(tmpdir(), `asana-cli-${input.client}-eval-`));
  try {
    const { project } = await installProjectSkill(binary, input.client, root);
    const schemaPath = join(root, "client-eval-output.schema.json");
    await writeFile(schemaPath, `${JSON.stringify(CLIENT_EVAL_OUTPUT_JSON_SCHEMA, null, 2)}\n`, {
      mode: 0o600,
    });
    const evaluated = await evaluateClient(input.client, executable, project, schemaPath);
    let response;
    try {
      response = validateClientEvalResponse(evaluated.response);
    } catch (error: unknown) {
      const parsed = clientEvalResponseSchema.safeParse(evaluated.response);
      if (!parsed.success) throw error;
      const commands = parsed.data.scenarios.map((scenario) => ({
        id: scenario.id,
        commands: scenario.commands,
      }));
      const reason = error instanceof Error ? error.message : "validation failed";
      throw new Error(`Client eval rejected: ${reason}; normalized commands: ${JSON.stringify(commands)}`);
    }
    const binaryBytes = await readFile(binary);
    return clientEvalEvidenceSchema.parse({
      schema: "asana-cli.client-eval-evidence.v1",
      client: input.client,
      client_version: evaluated.version,
      model: evaluated.model,
      evaluated_commit: await gitHead(),
      subject_sha256: await clientEvalSubjectSha256(),
      contract_sha256: await clientEvalContractSha256(),
      bundle_sha256: integrationBundleSha256(),
      skill_sha256: canonicalSkillSha256(),
      binary_sha256: createHash("sha256").update(binaryBytes).digest("hex"),
      transcript_sha256: createHash("sha256").update(evaluated.transcript, "utf8").digest("hex"),
      isolation: {
        scope: "project",
        session_persistence: false,
        user_configuration: false,
        tool_policy: input.client === "codex"
          ? "codex-read-only-no-env"
          : "claude-skill-only",
        external_commands_executed: false,
        asana_credentials_in_environment: false,
      },
      discovery: {
        skill_reported: response.skill_loaded,
        client_registry_observed: evaluated.registry_observed,
      },
      response,
      verdict: "passed",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const clientIndex = args.indexOf("--client");
  const outputIndex = args.indexOf("--output");
  const executableIndex = args.indexOf("--executable");
  const binaryIndex = args.indexOf("--binary");
  if (
    args.length !== 8 ||
    clientIndex === -1 ||
    outputIndex === -1 ||
    executableIndex === -1 ||
    binaryIndex === -1
  ) {
    throw new Error(
      "Usage: bun run scripts/run-client-evals.ts --client CLIENT --executable PATH --binary PATH --output FILE",
    );
  }
  const client = clientEvalIdSchema.parse(args[clientIndex + 1]);
  const output = z.string().min(1).parse(args[outputIndex + 1]);
  const executable = z.string().min(1).parse(args[executableIndex + 1]);
  const binary = z.string().min(1).parse(args[binaryIndex + 1]);
  const evidence = await runClientEval({ client, executable, binary });
  await mkdir(dirname(resolve(output)), { recursive: true, mode: 0o700 });
  await writeFile(resolve(output), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(
    `${client} client eval passed ${evidence.response.scenarios.length} scenarios; evidence ${output}\n`,
  );
}

if (import.meta.main) {
  await main();
}
