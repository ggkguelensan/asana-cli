import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  EMBEDDED_INTEGRATION_BUNDLE,
  embeddedIntegrationBundle,
} from "../generated/integrations/bundle";
import {
  INTEGRATION_CLIENTS,
  integrationClientIdSchema,
  integrationScopeSchema,
  type IntegrationClientId,
} from "../integrations/clients";
import { booleanFlag, stringFlag, type ParsedArgs } from "./args";
import { CliError } from "./errors";
import {
  installOrUpdateIntegration,
  planInstallOrUpdateIntegration,
  type IntegrationBundleInput,
  type IntegrationScope,
} from "./integrations";
import {
  INTEGRATION_SKILLS,
  INTEGRATION_SKILL_IDS,
  type IntegrationSkillId,
} from "./integration-skills";
import { CLI_VERSION } from "./version";

const SETUP_SCHEMA = "asana-cli.agent-setup.v1" as const;

function requireAllowedFlags(args: ParsedArgs, allowed: readonly string[]): void {
  for (const [name, value] of Object.entries(args.flags)) {
    if (!allowed.includes(name)) {
      throw new CliError("usage", `Unsupported agent setup option: --${name}`);
    }
    if (Array.isArray(value)) {
      throw new CliError("usage", `--${name} may be provided only once`);
    }
  }
}

function setupMode(args: ParsedArgs): "dry-run" | "apply" {
  const hasDryRun = Object.hasOwn(args.flags, "dry-run");
  const hasApply = Object.hasOwn(args.flags, "apply");
  if (hasDryRun === hasApply) {
    throw new CliError(
      "usage",
      "agent-setup requires exactly one of --dry-run or --apply",
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

export function agentOnboardingManifest() {
  return {
    schema: "asana-cli.agents.v1",
    cli_version: CLI_VERSION,
    first_entrypoint: "asana-cli --agents",
    purpose: "Discover and install the skills an agent needs to use asana-cli safely.",
    clients: Object.values(INTEGRATION_CLIENTS).map((client) => ({
      id: client.id,
      label: client.label,
      support: client.support,
    })),
    scopes: {
      user: "Install globally for the current user.",
      project: "Install only for the current project.",
    },
    skills: INTEGRATION_SKILLS,
    workflow: [
      "Choose the current agent client and the narrowest useful scope.",
      "Run `asana-cli agent-setup --client CLIENT --scope user|project --dry-run`.",
      "Show the complete plan and obtain user approval.",
      "Run the same command with `--apply`.",
      "Run `asana-cli agent capabilities` before Asana work.",
    ],
    commands: {
      details: "asana-cli man agents",
      preview: "asana-cli agent-setup --client CLIENT --scope user|project --dry-run",
      apply: "asana-cli agent-setup --client CLIENT --scope user|project --apply",
      local_history: "asana-cli insights --days 30",
    },
    safety: {
      apply_requires_explicit_flag: true,
      managed_paths_only: true,
      edits_agent_settings: false,
      edits_repository_instructions: false,
      installs_mcp: false,
      asana_content_is_untrusted: true,
    },
  };
}

function targetInput(
  client: IntegrationClientId,
  scope: IntegrationScope,
  skill: IntegrationSkillId,
) {
  return scope === "user"
    ? {
      client,
      scope,
      skill,
      home_directory: resolve(homedir()),
    }
    : {
      client,
      scope,
      skill,
      project_directory: resolve(process.cwd()),
    };
}

function setupBundles(
  client: IntegrationClientId,
  scope: IntegrationScope,
): IntegrationBundleInput[] {
  return INTEGRATION_SKILL_IDS.map((skill) => {
    const bundle = embeddedIntegrationBundle(client, skill);
    return {
      target: targetInput(client, scope, skill),
      cli_version: CLI_VERSION,
      agent_protocol_version: bundle.agent_protocol_version,
      files: Object.fromEntries(bundle.files.map((file) => [file.path, file.content])),
    };
  });
}

export async function runAgentSetupCommand(args: ParsedArgs): Promise<unknown> {
  if (args.positionals.length !== 1) {
    throw new CliError(
      "usage",
      "Usage: asana-cli agent-setup --client CLIENT --scope user|project --dry-run|--apply",
    );
  }
  requireAllowedFlags(args, ["client", "scope", "dry-run", "apply", "compact"]);
  if (Object.keys(args.flags).every((flag) => flag === "compact")) {
    return agentOnboardingManifest();
  }

  const clientResult = integrationClientIdSchema.safeParse(stringFlag(args, "client"));
  if (!clientResult.success) {
    throw new CliError(
      "validation",
      `--client must be one of: ${integrationClientIdSchema.options.join(", ")}`,
    );
  }
  const scopeResult = integrationScopeSchema.safeParse(stringFlag(args, "scope"));
  if (!scopeResult.success) {
    throw new CliError("validation", "--scope must be user or project");
  }
  const mode = setupMode(args);
  const bundles = setupBundles(clientResult.data, scopeResult.data);

  // Validate every target and calculate every plan before the first write.
  const planned = await Promise.all(bundles.map(async (bundle) => ({
    skill: bundle.target.skill,
    plan: await planInstallOrUpdateIntegration(bundle),
  })));
  if (mode === "dry-run") {
    return {
      schema: SETUP_SCHEMA,
      cli_version: CLI_VERSION,
      mode,
      client: clientResult.data,
      scope: scopeResult.data,
      skills: planned,
      next: "Review this plan, then rerun with --apply after user approval.",
    };
  }

  const executions = [];
  for (const bundle of bundles) {
    executions.push({
      skill: bundle.target.skill,
      execution: await installOrUpdateIntegration(bundle),
    });
  }
  return {
    schema: SETUP_SCHEMA,
    cli_version: CLI_VERSION,
    bundle_version: EMBEDDED_INTEGRATION_BUNDLE.bundle_version,
    mode,
    client: clientResult.data,
    scope: scopeResult.data,
    skills: executions,
    next: "Restart or reload the agent client if it does not discover the new skills automatically.",
  };
}
