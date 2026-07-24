import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  EMBEDDED_INTEGRATION_BUNDLE,
  type EmbeddedIntegrationClientId,
} from "../generated/integrations/bundle";
import {
  supportedBuildTargetSchema,
  type SupportedBuildTarget,
} from "./check-support-matrix";
import { clientEvalSubjectSha256 } from "./client-eval-contract";
import { integrationClientIdSchema } from "../integrations/clients";

const clientSchema = integrationClientIdSchema;
const scopeSchema = z.enum(["user", "project"]);
const planOutputSchema = z.looseObject({
  action: z.enum(["install", "update", "uninstall", "none"]),
  current_state: z.enum(["absent", "managed", "modified", "unmanaged", "invalid", "unsafe"]),
});
const executionOutputSchema = z.looseObject({
  execution: z.looseObject({
    action: z.enum(["install", "update", "uninstall", "none"]),
  }),
});
const statusOutputSchema = z.looseObject({
  state: z.enum(["absent", "managed", "modified", "unmanaged", "invalid", "unsafe"]),
});
const detectionOutputSchema = z.looseObject({
  discovery: z.enum(["found", "absent", "unsafe"]),
});
const listOutputSchema = z.looseObject({
  runtime: z.strictObject({
    platform: z.enum(["darwin", "linux"]),
    architecture: z.enum(["arm64", "x64"]),
  }),
});

type Scope = z.output<typeof scopeSchema>;

const lifecycleCases = clientSchema.options.flatMap((client) =>
  scopeSchema.options.map((scope) => ({ client, scope }))
);

export const integrationLifecycleEvidenceSchema = z.strictObject({
  schema: z.literal("asana-cli.integration-lifecycle-evidence.v1"),
  target: supportedBuildTargetSchema.optional(),
  platform: z.enum(["darwin", "linux"]),
  architecture: z.enum(["arm64", "x64"]),
  subject_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  binary_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bundle_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  cases: z.array(z.strictObject({
    client: clientSchema,
    scope: scopeSchema,
    status: z.literal("passed"),
  })).length(lifecycleCases.length).superRefine((cases, context) => {
    const actual = cases.map(({ client, scope }) => `${client}:${scope}`);
    const expected = lifecycleCases.map(({ client, scope }) => `${client}:${scope}`);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      context.addIssue({
        code: "custom",
        message: "lifecycle evidence must contain every client/scope case in canonical order",
      });
    }
  }),
});
export type IntegrationLifecycleEvidence = z.output<typeof integrationLifecycleEvidenceSchema>;

const targetRuntime: Readonly<Record<
  SupportedBuildTarget,
  Readonly<{ platform: "darwin" | "linux"; architecture: "arm64" | "x64" }>
>> = {
  "bun-darwin-arm64": { platform: "darwin", architecture: "arm64" },
  "bun-darwin-x64": { platform: "darwin", architecture: "x64" },
  "bun-linux-arm64": { platform: "linux", architecture: "arm64" },
  "bun-linux-x64-baseline": { platform: "linux", architecture: "x64" },
  "bun-linux-arm64-musl": { platform: "linux", architecture: "arm64" },
  "bun-linux-x64-baseline-musl": { platform: "linux", architecture: "x64" },
};

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new Error("Integration lifecycle command returned invalid JSON");
  }
}

async function invoke(
  binary: string,
  args: readonly string[],
  context: Readonly<{ home: string; project: string }>,
): Promise<unknown> {
  const child = Bun.spawn([binary, ...args], {
    cwd: context.project,
    env: {
      ...process.env,
      HOME: context.home,
      XDG_CONFIG_HOME: join(context.home, ".config"),
      XDG_STATE_HOME: join(context.home, ".local", "state"),
      ASANA_ACCESS_TOKEN: "",
      ASANA_PAT: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `Integration lifecycle command failed (${args.join(" ")}): ${stderr.trim() || `exit ${exitCode}`}`,
    );
  }
  return parseJson(stdout);
}

function installationDirectory(
  base: string,
  client: EmbeddedIntegrationClientId,
  scope: Scope,
): string {
  const bundle = EMBEDDED_INTEGRATION_BUNDLE.clients.find((candidate) => candidate.client === client);
  if (!bundle) throw new Error(`Missing embedded integration bundle for ${client}`);
  return join(base, ...bundle.install_roots[scope].split("/"));
}

async function runCase(
  binary: string,
  root: string,
  client: EmbeddedIntegrationClientId,
  scope: Scope,
): Promise<void> {
  const caseRoot = join(root, `${client}-${scope}`);
  const home = join(caseRoot, "home");
  const project = join(caseRoot, "project");
  await Promise.all([
    mkdir(home, { recursive: true, mode: 0o700 }),
    mkdir(project, { recursive: true, mode: 0o700 }),
  ]);
  const base = scope === "user" ? home : project;
  const unrelated = join(base, "AGENTS.md");
  await writeFile(unrelated, "integration lifecycle sentinel\n", { mode: 0o600 });
  const context = { home, project };
  const target = ["--client", client, "--scope", scope] as const;

  const before = planOutputSchema.parse(
    await invoke(binary, ["integrations", "diff", ...target], context),
  );
  if (before.action !== "install" || before.current_state !== "absent") {
    throw new Error(`Unexpected pre-install state for ${client}/${scope}`);
  }

  const preview = planOutputSchema.parse(
    await invoke(binary, ["integrations", "install", ...target, "--dry-run"], context),
  );
  if (preview.action !== "install") throw new Error(`Install preview failed for ${client}/${scope}`);

  const installed = executionOutputSchema.parse(
    await invoke(binary, ["integrations", "install", ...target, "--apply"], context),
  );
  if (installed.execution.action !== "install") {
    throw new Error(`Install apply failed for ${client}/${scope}`);
  }

  const detected = detectionOutputSchema.parse(
    await invoke(binary, ["integrations", "detect", ...target], context),
  );
  if (detected.discovery !== "found") throw new Error(`Discovery failed for ${client}/${scope}`);

  const status = statusOutputSchema.parse(
    await invoke(binary, ["integrations", "status", ...target], context),
  );
  if (status.state !== "managed") throw new Error(`Managed status failed for ${client}/${scope}`);

  const updated = executionOutputSchema.parse(
    await invoke(binary, ["integrations", "update", ...target, "--apply"], context),
  );
  if (updated.execution.action !== "none") {
    throw new Error(`No-op update failed for ${client}/${scope}`);
  }

  const uninstallPreview = planOutputSchema.parse(
    await invoke(binary, ["integrations", "uninstall", ...target, "--dry-run"], context),
  );
  if (uninstallPreview.action !== "uninstall") {
    throw new Error(`Uninstall preview failed for ${client}/${scope}`);
  }

  const uninstalled = executionOutputSchema.parse(
    await invoke(binary, ["integrations", "uninstall", ...target, "--apply"], context),
  );
  if (uninstalled.execution.action !== "uninstall") {
    throw new Error(`Uninstall apply failed for ${client}/${scope}`);
  }

  const after = statusOutputSchema.parse(
    await invoke(binary, ["integrations", "status", ...target], context),
  );
  if (after.state !== "absent") throw new Error(`Post-uninstall state failed for ${client}/${scope}`);
  if (await readFile(unrelated, "utf8") !== "integration lifecycle sentinel\n") {
    throw new Error(`Lifecycle modified an unrelated file for ${client}/${scope}`);
  }
  try {
    await lstat(installationDirectory(base, client, scope));
    throw new Error(`Integration directory remains after uninstall for ${client}/${scope}`);
  } catch (error: unknown) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}

export async function runIntegrationLifecycleE2e(
  binaryArgument: string,
  targetArgument?: string,
): Promise<IntegrationLifecycleEvidence> {
  const binary = isAbsolute(binaryArgument) ? binaryArgument : resolve(binaryArgument);
  const target = targetArgument === undefined
    ? undefined
    : supportedBuildTargetSchema.parse(targetArgument);
  const binaryBytes = await readFile(binary);
  const root = await mkdtemp(join(tmpdir(), "asana-cli-native-lifecycle-"));
  try {
    const probeHome = join(root, "runtime", "home");
    const probeProject = join(root, "runtime", "project");
    await Promise.all([
      mkdir(probeHome, { recursive: true, mode: 0o700 }),
      mkdir(probeProject, { recursive: true, mode: 0o700 }),
    ]);
    const runtime = listOutputSchema.parse(
      await invoke(binary, ["integrations", "list"], { home: probeHome, project: probeProject }),
    ).runtime;
    if (target !== undefined) {
      const expectedRuntime = targetRuntime[target];
      if (
        runtime.platform !== expectedRuntime.platform ||
        runtime.architecture !== expectedRuntime.architecture
      ) {
        throw new Error(`Artifact runtime does not match ${target}`);
      }
    }
    for (const testCase of lifecycleCases) {
      await runCase(binary, root, testCase.client, testCase.scope);
    }
    return integrationLifecycleEvidenceSchema.parse({
      schema: "asana-cli.integration-lifecycle-evidence.v1",
      ...(target === undefined ? {} : { target }),
      platform: runtime.platform,
      architecture: runtime.architecture,
      subject_sha256: await clientEvalSubjectSha256(),
      binary_sha256: createHash("sha256").update(binaryBytes).digest("hex"),
      bundle_sha256: createHash("sha256")
        .update(JSON.stringify(EMBEDDED_INTEGRATION_BUNDLE), "utf8")
        .digest("hex"),
      cases: lifecycleCases.map((testCase) => ({ ...testCase, status: "passed" })),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--output");
  const output = outputIndex === -1 ? undefined : args[outputIndex + 1];
  const positionals = outputIndex === -1
    ? args
    : args.filter((_, index) => index !== outputIndex && index !== outputIndex + 1);
  const [binary, target, ...unexpected] = positionals;
  if (
    !binary ||
    unexpected.length > 0 ||
    (outputIndex !== -1 && (!output || outputIndex + 2 !== args.length))
  ) {
    throw new Error(
      "Usage: bun run scripts/integration-lifecycle-e2e.ts BINARY [TARGET] [--output FILE]",
    );
  }
  const evidence = await runIntegrationLifecycleE2e(binary, target);
  if (output === undefined) {
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } else {
    await mkdir(dirname(resolve(output)), { recursive: true, mode: 0o700 });
    await writeFile(resolve(output), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`Integration lifecycle passed for ${target ?? "native runtime"}; evidence ${output}\n`);
  }
}
