import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  EMBEDDED_INTEGRATION_BUNDLE,
  embeddedIntegrationBundle,
} from "../generated/integrations/bundle";
import {
  INTEGRATION_CLIENTS,
  integrationClientIdSchema,
  integrationScopeSchema,
} from "../integrations/clients";
import {
  clientAdapter,
  clientAdapterDetectionProbes,
  renderClientPolicyGuidance,
} from "./client-adapter-specs";
import { booleanFlag, stringFlag, type ParsedArgs } from "./args";
import { CliError } from "./errors";
import {
  diffIntegration,
  doctorIntegration,
  inspectIntegration,
  installIntegration,
  planInstallIntegration,
  planUninstallIntegration,
  planUpdateIntegration,
  uninstallIntegration,
  updateIntegration,
  type IntegrationTargetInput,
} from "./integrations";
import { resolveIntegrationPaths } from "./integrations/paths";
import { CLI_VERSION } from "./version";

const integrationActionSchema = z.enum([
  "list",
  "detect",
  "status",
  "doctor",
  "policy",
  "install",
  "update",
  "diff",
  "uninstall",
]);

type IntegrationExecutionMode = "dry-run" | "apply";

function requireExactPositionals(args: ParsedArgs, expected: number, usage: string): void {
  if (args.positionals.length !== expected) {
    throw new CliError("usage", `Usage: ${usage}`);
  }
}

function requireAllowedFlags(args: ParsedArgs, allowed: readonly string[]): void {
  for (const [name, value] of Object.entries(args.flags)) {
    if (!allowed.includes(name)) {
      throw new CliError("usage", `Unsupported option for integrations command: --${name}`);
    }
    if (Array.isArray(value)) {
      throw new CliError("usage", `--${name} may be provided only once`);
    }
  }
}

function integrationClientOption(value: unknown, label: "--client" | "CLIENT") {
  const parsed = integrationClientIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new CliError("validation", `${label} must be generic-agent-skills, codex, or claude-code`);
  }
  return parsed.data;
}

function integrationScopeOption(value: unknown) {
  const parsed = integrationScopeSchema.safeParse(value);
  if (!parsed.success) {
    throw new CliError("validation", "--scope must be user or project");
  }
  return parsed.data;
}

function integrationTarget(args: ParsedArgs): IntegrationTargetInput {
  const client = integrationClientOption(stringFlag(args, "client"), "--client");
  const scope = integrationScopeOption(stringFlag(args, "scope"));
  return scope === "user"
    ? { client, scope, home_directory: resolve(homedir()) }
    : { client, scope, project_directory: resolve(process.cwd()) };
}

function bundleForTarget(target: IntegrationTargetInput) {
  const bundle = embeddedIntegrationBundle(target.client);
  return {
    target,
    cli_version: CLI_VERSION,
    agent_protocol_version: bundle.agent_protocol_version,
    files: Object.fromEntries(bundle.files.map((file) => [file.path, file.content])),
  };
}

function executionMode(args: ParsedArgs, action: "install" | "update" | "uninstall"): IntegrationExecutionMode {
  const hasDryRun = Object.hasOwn(args.flags, "dry-run");
  const hasApply = Object.hasOwn(args.flags, "apply");
  if (hasDryRun === hasApply) {
    throw new CliError(
      "usage",
      `${action} requires exactly one of --dry-run (show the full plan) or --apply (perform the displayed plan)`,
    );
  }
  if (hasDryRun && !booleanFlag(args, "dry-run")) {
    throw new CliError("usage", "--dry-run must be enabled when supplied");
  }
  if (hasApply && !booleanFlag(args, "apply")) {
    throw new CliError("usage", "--apply must be enabled when supplied");
  }
  return hasDryRun ? "dry-run" : "apply";
}

async function probeFile(path: string): Promise<"present" | "absent" | "unsafe"> {
  try {
    const stats = await lstat(path);
    return stats.isFile() && !stats.isSymbolicLink() ? "present" : "unsafe";
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
    if (code === "ENOENT") return "absent";
    throw error;
  }
}

async function detectIntegration(target: IntegrationTargetInput) {
  const paths = resolveIntegrationPaths(target);
  const client = INTEGRATION_CLIENTS[target.client];
  const adapter = clientAdapter(target.client);
  const inspection = await inspectIntegration(target);
  if (inspection.state === "unsafe") {
    return {
      client,
      target: paths,
      discovery: "unsafe" as const,
      inspection,
      probes: [],
    };
  }

  const probes = await Promise.all(clientAdapterDetectionProbes(adapter).map(async (probe) => ({
    relative_path: probe.relativePath,
    expected_kind: probe.expectedKind,
    required: probe.required,
    status: await probeFile(join(paths.installation_directory, probe.relativePath)),
  })));
  return {
    client,
    target: paths,
    discovery: probes.every((probe) => !probe.required || probe.status === "present") ? "found" as const : "absent" as const,
    inspection,
    probes,
  };
}

async function mutateIntegration(
  action: "install" | "update" | "uninstall",
  target: IntegrationTargetInput,
  mode: IntegrationExecutionMode,
) {
  const bundle = action === "uninstall" ? undefined : bundleForTarget(target);
  const plan = action === "install"
    ? await planInstallIntegration(bundle)
    : action === "update"
      ? await planUpdateIntegration(bundle)
      : await planUninstallIntegration(target);
  if (mode === "dry-run") return plan;

  const execution = action === "install"
    ? await installIntegration(bundle)
    : action === "update"
      ? await updateIntegration(bundle)
      : await uninstallIntegration(target);
  return { plan, execution };
}

/**
 * Routes integrations before credential resolution. It uses the statically embedded
 * bundle only; no runtime repository skill source or client settings are consulted.
 */
export async function runIntegrationCommand(args: ParsedArgs): Promise<{ value?: unknown; text?: string }> {
  const actionResult = integrationActionSchema.safeParse(args.positionals[1]);
  if (!actionResult.success) {
    throw new CliError("usage", "Unknown integrations action; run `asana-cli integrations list`");
  }
  const action = actionResult.data;
  if (action === "list") {
    requireExactPositionals(args, 2, "asana-cli integrations list");
    requireAllowedFlags(args, ["compact"]);
    return {
      value: {
        schema: EMBEDDED_INTEGRATION_BUNDLE.schema,
        bundle_version: EMBEDDED_INTEGRATION_BUNDLE.bundle_version,
        agent_protocol_version: EMBEDDED_INTEGRATION_BUNDLE.agent_protocol_version,
        clients: INTEGRATION_CLIENTS,
      },
    };
  }

  if (action === "policy") {
    requireExactPositionals(args, 3, "asana-cli integrations policy CLIENT");
    requireAllowedFlags(args, []);
    return { text: renderClientPolicyGuidance(integrationClientOption(args.positionals[2], "CLIENT")) };
  }

  requireExactPositionals(args, 2, `asana-cli integrations ${action} --client CLIENT --scope user|project`);
  const mutation = action === "install" || action === "update" || action === "uninstall";
  requireAllowedFlags(args, mutation ? ["client", "scope", "dry-run", "apply", "compact"] : ["client", "scope", "compact"]);
  const target = integrationTarget(args);

  if (action === "detect") return { value: await detectIntegration(target) };
  if (action === "status") return { value: await inspectIntegration(target) };
  if (action === "doctor") return { value: await doctorIntegration({ target }) };
  if (action === "diff") return { value: await diffIntegration(bundleForTarget(target)) };

  const mode = executionMode(args, action);
  return { value: await mutateIntegration(action, target, mode) };
}

