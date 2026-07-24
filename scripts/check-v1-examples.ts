import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { FileOperationRepository } from "../src/operations/file-repository";
import { resolveOperationJournalDirectory } from "../src/operations/paths";
import { operationStatusProjectionSchema } from "../src/operations/status-projection";

const projectRoot = resolve(import.meta.dir, "..");
const documentationPath = join(projectRoot, "docs", "v1-workflows.md");
const defaultBinaryPath = join(projectRoot, "dist", "asana-cli");
const operationId = "00000000-0000-4000-8000-000000001001";
const payloadCanary = "V1_RECOVERY_PAYLOAD_CANARY_184729";
const credentialCanary = "V1_AUTH_CREDENTIAL_CANARY_835104";
const permissionCanary = "V1_PERMISSION_RULE_CANARY_492761";

export const V1_DOCUMENTED_COMMANDS = Object.freeze([
  "asana-cli integrations diff --client codex --scope project",
  "asana-cli integrations install --client codex --scope project --dry-run",
  "asana-cli integrations install --client codex --scope project --apply",
  "asana-cli integrations status --client codex --scope project",
  "asana-cli integrations uninstall --client codex --scope project --dry-run",
  "asana-cli integrations uninstall --client codex --scope project --apply",
  "env -u ASANA_ACCESS_TOKEN -u ASANA_PAT asana-cli integrations doctor --client codex --scope project --skip-credential-store",
  "ASANA_ACCESS_TOKEN='replace-with-a-temporary-PAT' asana-cli integrations doctor --client codex --scope project --skip-credential-store",
  "asana-cli integrations policy codex",
  "asana-cli integrations doctor --client codex --scope project --skip-credential-store --auto-allow 'Bash(asana-cli *)'",
  'asana-cli agent operation status "$OPERATION_ID"',
] as const);

const integrationPlanSchema = z.looseObject({
  action: z.enum(["install", "uninstall"]),
  current_state: z.string(),
  target: z.object({ scope: z.literal("project") }).passthrough(),
  changes: z.array(z.unknown()).min(1),
});
const integrationExecutionSchema = z.looseObject({
  plan: integrationPlanSchema,
  execution: z.looseObject({
    action: z.enum(["install", "uninstall"]),
    changes: z.array(z.unknown()).min(1),
  }),
});
const integrationInspectionSchema = z.looseObject({
  state: z.enum(["absent", "managed"]),
  target: z.object({ scope: z.literal("project") }).passthrough(),
});
const doctorSchema = z.looseObject({
  inherited_credentials: z.array(z.enum(["ASANA_ACCESS_TOKEN", "ASANA_PAT"])),
  credential_sources: z.looseObject({
    effective: z.enum(["ASANA_ACCESS_TOKEN", "ASANA_PAT", "os-credential-store", "none", "unknown"]),
    environment: z.looseObject({
      status: z.enum(["clear", "inherited"]),
      names: z.array(z.enum(["ASANA_ACCESS_TOKEN", "ASANA_PAT"])),
    }),
    os_credential_store: z.looseObject({ status: z.literal("not-checked") }),
  }),
  warnings: z.array(z.looseObject({ code: z.string(), message: z.string() })),
  permission_review: z.looseObject({
    status: z.enum(["not-provided", "no-known-broad-permissions", "unsafe"]),
    checked_rules: z.number().int().nonnegative(),
    findings: z.array(z.looseObject({
      rule_index: z.number().int().nonnegative(),
      code: z.string(),
    })),
  }),
});
const operationEnvelopeSchema = z.looseObject({
  schema: z.literal("asana-cli.agent.v2"),
  result: z.looseObject({
    operation: z.literal("operation.status"),
    effect: z.literal("read"),
    data: operationStatusProjectionSchema,
  }),
});

type CommandResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} did not return JSON`, { cause: error });
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isolatedEnvironment(
  home: string,
  state: string,
  additions: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        ![
          "ASANA_ACCESS_TOKEN",
          "ASANA_PAT",
          "ASANA_CLI_AGENT_POLICY",
          "NODE_TLS_REJECT_UNAUTHORIZED",
          "HOME",
          "XDG_STATE_HOME",
        ].includes(entry[0]),
    ),
  );
  return {
    ...environment,
    HOME: home,
    XDG_STATE_HOME: state,
    ASANA_ACCESS_TOKEN: "",
    ASANA_PAT: "",
    ASANA_CLI_AGENT_POLICY: "read",
    NODE_TLS_REJECT_UNAUTHORIZED: "",
    ...additions,
  };
}

async function runBinary(
  binaryPath: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
): Promise<CommandResult> {
  const child = Bun.spawn({
    cmd: [binaryPath, ...args],
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 10_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timeout);
  }
}

async function successfulJson(
  binaryPath: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
): Promise<unknown> {
  const result = await runBinary(binaryPath, args, cwd, env);
  assert(
    result.exitCode === 0,
    `${args.join(" ")} failed with exit code ${result.exitCode}: ${result.stderr}`,
  );
  assert(result.stderr === "", `${args.join(" ")} unexpectedly wrote to stderr`);
  return parseJson(result.stdout, args.join(" "));
}

export function validateV1WorkflowDocumentation(markdown: string): void {
  for (const command of V1_DOCUMENTED_COMMANDS) {
    if (!markdown.includes(command)) {
      throw new Error(`Critical workflow documentation is missing command: ${command}`);
    }
  }
  for (const requiredGuidance of [
    'permission_review.status: "unsafe"',
    "`broad-cli`",
    'next_step: "inspect-asana-and-obtain-human-direction"',
    "Do not retry the operation",
  ]) {
    if (!markdown.includes(requiredGuidance)) {
      throw new Error(`Critical workflow documentation is missing guidance: ${requiredGuidance}`);
    }
  }
}

export async function runV1Examples(
  binaryArgument: string = defaultBinaryPath,
  markdown?: string,
): Promise<Readonly<{ commands: number; workflows: 4 }>> {
  const binaryPath = resolve(binaryArgument);
  assert(isAbsolute(binaryPath), "Compiled binary path must be absolute");
  const docs = markdown ?? await readFile(documentationPath, "utf8");
  validateV1WorkflowDocumentation(docs);

  const root = await mkdtemp(join(tmpdir(), "asana-cli-v1-examples-"));
  const home = join(root, "home");
  const state = join(root, "state");
  const project = join(root, "project");
  await Promise.all([mkdir(home), mkdir(state), mkdir(project)]);
  const environment = isolatedEnvironment(home, state);
  let commandCount = 0;
  const json = async (args: readonly string[], env = environment): Promise<unknown> => {
    commandCount += 1;
    return successfulJson(binaryPath, args, project, env);
  };

  try {
    const sentinelPath = join(project, "AGENTS.md");
    const sentinel = "V1_INSTALLATION_SENTINEL\n";
    await writeFile(sentinelPath, sentinel);

    const diff = integrationPlanSchema.parse(await json([
      "integrations", "diff", "--client", "codex", "--scope", "project",
    ]));
    assert(diff.action === "install", "Initial integration diff must plan an install");
    const installPreview = integrationPlanSchema.parse(await json([
      "integrations", "install", "--client", "codex", "--scope", "project", "--dry-run",
    ]));
    assert(installPreview.action === "install", "Install preview must remain an install plan");
    const installed = integrationExecutionSchema.parse(await json([
      "integrations", "install", "--client", "codex", "--scope", "project", "--apply",
    ]));
    assert(installed.execution.action === "install", "Install apply did not execute the install");
    const managed = integrationInspectionSchema.parse(await json([
      "integrations", "status", "--client", "codex", "--scope", "project",
    ]));
    assert(managed.state === "managed", "Installed Codex skill was not reported as managed");
    const uninstallPreview = integrationPlanSchema.parse(await json([
      "integrations", "uninstall", "--client", "codex", "--scope", "project", "--dry-run",
    ]));
    assert(uninstallPreview.action === "uninstall", "Uninstall preview must remain an uninstall plan");
    const uninstalled = integrationExecutionSchema.parse(await json([
      "integrations", "uninstall", "--client", "codex", "--scope", "project", "--apply",
    ]));
    assert(uninstalled.execution.action === "uninstall", "Uninstall apply did not execute the uninstall");
    const absent = integrationInspectionSchema.parse(await json([
      "integrations", "status", "--client", "codex", "--scope", "project",
    ]));
    assert(absent.state === "absent", "Removed Codex skill was not reported as absent");
    assert(await readFile(sentinelPath, "utf8") === sentinel, "Integration lifecycle changed AGENTS.md");

    const noCredential = doctorSchema.parse(await json([
      "integrations", "doctor", "--client", "codex", "--scope", "project",
      "--skip-credential-store",
    ]));
    assert(noCredential.credential_sources.effective === "none", "No-PAT doctor did not report none");
    assert(noCredential.credential_sources.environment.status === "clear", "No-PAT environment was not clear");

    const inheritedEnvironment = isolatedEnvironment(home, state, {
      ASANA_ACCESS_TOKEN: credentialCanary,
    });
    const inheritedResult = await runBinary(binaryPath, [
      "integrations", "doctor", "--client", "codex", "--scope", "project",
      "--skip-credential-store",
    ], project, inheritedEnvironment);
    commandCount += 1;
    assert(inheritedResult.exitCode === 0 && inheritedResult.stderr === "", "Inherited-PAT doctor failed");
    assert(!inheritedResult.stdout.includes(credentialCanary), "Doctor exposed the inherited PAT");
    const inherited = doctorSchema.parse(parseJson(inheritedResult.stdout, "Inherited-PAT doctor"));
    assert(
      inherited.credential_sources.effective === "ASANA_ACCESS_TOKEN",
      "Doctor did not identify the effective environment credential source",
    );
    assert(
      inherited.warnings.some((warning) => warning.code === "inherited-environment-credential"),
      "Doctor omitted the inherited credential warning",
    );

    commandCount += 1;
    const policy = await runBinary(binaryPath, ["integrations", "policy", "codex"], project, environment);
    assert(policy.exitCode === 0 && policy.stderr === "", "Client policy command failed");
    assert(policy.stdout.includes("asana-cli agent apply --operation-id UUID"), "Policy omitted apply approval");
    assert(policy.stdout.includes("asana-cli request *"), "Policy omitted a prohibited raw command");

    const broadRule = `Bash(asana-cli *) # ${permissionCanary}`;
    const broadResult = await runBinary(binaryPath, [
      "integrations", "doctor", "--client", "codex", "--scope", "project",
      "--skip-credential-store", "--auto-allow", broadRule,
    ], project, environment);
    commandCount += 1;
    assert(broadResult.exitCode === 0 && broadResult.stderr === "", "Broad-permission doctor failed");
    assert(!broadResult.stdout.includes(permissionCanary), "Doctor echoed the inspected host rule");
    const broad = doctorSchema.parse(parseJson(broadResult.stdout, "Broad-permission doctor"));
    assert(broad.permission_review.status === "unsafe", "Broad CLI permission was not unsafe");
    assert(
      broad.permission_review.findings.some((finding) => finding.code === "broad-cli"),
      "Broad CLI permission did not produce the broad-cli finding",
    );

    const baseDirectory = resolveOperationJournalDirectory({
      HOME: home,
      XDG_STATE_HOME: state,
    });
    const repository = new FileOperationRepository({
      baseDirectory,
      clock: () => new Date("2026-07-24T00:00:00.000Z"),
      idGenerator: () => operationId,
    });
    await repository.create({
      operation: "task.comment",
      target: { task_gid: "123" },
      payload: { text: payloadCanary },
      guards: {
        expected_modified_at: "2026-07-23T00:00:00.000Z",
        prepared_by_gid: "999",
      },
      ttl_ms: 60 * 60 * 1_000,
    });
    const applying = await repository.compareAndSet({
      id: operationId,
      expected_state: "prepared",
      next_state: "applying",
    });
    assert(applying.updated, "Recovery fixture did not enter applying");
    const unknown = await repository.compareAndSet({
      id: operationId,
      expected_state: "applying",
      next_state: "unknown",
      metadata: { error_code: "APPLY_FAILED" },
    });
    assert(unknown.updated, "Recovery fixture did not enter unknown");

    const recoveryResult = await runBinary(binaryPath, [
      "agent", "operation", "status", operationId,
    ], project, environment);
    commandCount += 1;
    assert(recoveryResult.exitCode === 0 && recoveryResult.stderr === "", "Local recovery status failed");
    assert(!recoveryResult.stdout.includes(payloadCanary), "Recovery status exposed the write payload");
    assert(!recoveryResult.stdout.includes(credentialCanary), "Recovery status exposed a credential");
    const recovery = operationEnvelopeSchema.parse(parseJson(recoveryResult.stdout, "Operation recovery"));
    assert(recovery.result.data.state === "unknown", "Recovery status did not preserve unknown state");
    assert(
      recovery.result.data.next_step === "inspect-asana-and-obtain-human-direction",
      "Recovery status suggested an unsafe next step",
    );
    assert(
      recovery.result.data.result?.outcome === "unknown" &&
      recovery.result.data.result.request_may_have_succeeded,
      "Recovery status omitted ambiguous-outcome metadata",
    );

    return { commands: commandCount, workflows: 4 };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [binaryArgument, ...unexpected] = process.argv.slice(2);
  if (unexpected.length > 0) {
    throw new Error("Usage: bun run scripts/check-v1-examples.ts [binary-path]");
  }
  const result = await runV1Examples(binaryArgument ?? defaultBinaryPath);
  process.stdout.write(
    `Critical v1 examples passed: ${result.workflows} workflows, ${result.commands} compiled-binary commands\n`,
  );
}
