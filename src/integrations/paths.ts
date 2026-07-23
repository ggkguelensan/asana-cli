import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { CliError } from "../errors";
import { assertSupportedRuntimePlatform } from "../platform-support";
import {
  INTEGRATION_MANIFEST_FILE,
  integrationTargetInputSchema,
  type IntegrationClient,
  type IntegrationScope,
  type IntegrationTargetInput,
} from "./schemas";

export type IntegrationPaths = Readonly<{
  client: IntegrationClient;
  scope: IntegrationScope;
  base_directory: string;
  installation_directory: string;
  manifest_path: string;
}>;

const ROOT_SEGMENTS: Record<IntegrationClient, readonly string[]> = {
  "generic-agent-skills": [".agents", "skills", "asana"],
  codex: [".agents", "skills", "asana"],
  "claude-code": [".claude", "skills", "asana"],
};

/** Resolves only fixed skill roots; callers cannot redirect lifecycle writes to settings or hooks. */
export function resolveIntegrationPaths(
  value: unknown,
): IntegrationPaths {
  assertSupportedRuntimePlatform();
  const input: IntegrationTargetInput = integrationTargetInputSchema.parse(value);
  const configuredBase = input.scope === "user" ? input.home_directory : input.project_directory;
  const source = input.scope === "user" ? "home_directory" : "project_directory";
  if (!configuredBase) {
    throw new CliError("validation", `${source} is required for ${input.scope} integrations`);
  }
  if (!isAbsolute(configuredBase)) {
    throw new CliError("validation", `${source} must be an absolute path`);
  }

  const baseDirectory = resolve(configuredBase);
  const installationDirectory = resolve(baseDirectory, ...ROOT_SEGMENTS[input.client]);
  const pathBelowBase = relative(baseDirectory, installationDirectory);
  if (
    pathBelowBase.length === 0 ||
    pathBelowBase === ".." ||
    pathBelowBase.startsWith(`..${sep}`) ||
    isAbsolute(pathBelowBase)
  ) {
    throw new CliError("internal", "integration target escaped its fixed root");
  }

  return {
    client: input.client,
    scope: input.scope,
    base_directory: baseDirectory,
    installation_directory: installationDirectory,
    manifest_path: join(installationDirectory, INTEGRATION_MANIFEST_FILE),
  };
}
