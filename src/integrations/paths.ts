import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { CliError } from "../errors";
import {
  INTEGRATION_MANIFEST_FILE,
  integrationTargetInputSchema,
  type IntegrationClient,
  type IntegrationScope,
  type IntegrationTargetInput,
} from "./schemas";

export type IntegrationPlatform = "darwin" | "linux" | "win32";

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

function platformOf(platform: IntegrationPlatform | undefined): IntegrationPlatform {
  if (platform) return platform;
  if (process.platform === "win32") return "win32";
  return process.platform === "darwin" ? "darwin" : "linux";
}

function isPlatformAbsolute(path: string, platform: IntegrationPlatform): boolean {
  return platform === "win32" ? win32.isAbsolute(path) : isAbsolute(path);
}

/** Resolves only fixed skill roots; callers cannot redirect lifecycle writes to settings or hooks. */
export function resolveIntegrationPaths(
  value: unknown,
  platform?: IntegrationPlatform,
): IntegrationPaths {
  const input: IntegrationTargetInput = integrationTargetInputSchema.parse(value);
  const resolvedPlatform = platformOf(platform);
  const configuredBase = input.scope === "user" ? input.home_directory : input.project_directory;
  const source = input.scope === "user" ? "home_directory" : "project_directory";
  if (!configuredBase) {
    throw new CliError("validation", `${source} is required for ${input.scope} integrations`);
  }
  if (!isPlatformAbsolute(configuredBase, resolvedPlatform)) {
    throw new CliError("validation", `${source} must be an absolute path`);
  }

  const pathApi = resolvedPlatform === "win32" ? win32 : { join, relative, resolve };
  const pathSeparator = resolvedPlatform === "win32" ? win32.sep : sep;
  const baseDirectory = pathApi.resolve(configuredBase);
  const installationDirectory = pathApi.resolve(baseDirectory, ...ROOT_SEGMENTS[input.client]);
  const pathBelowBase = pathApi.relative(baseDirectory, installationDirectory);
  if (
    pathBelowBase.length === 0 ||
    pathBelowBase === ".." ||
    pathBelowBase.startsWith(`..${pathSeparator}`) ||
    isPlatformAbsolute(pathBelowBase, resolvedPlatform)
  ) {
    throw new CliError("internal", "integration target escaped its fixed root");
  }

  return {
    client: input.client,
    scope: input.scope,
    base_directory: baseDirectory,
    installation_directory: installationDirectory,
    manifest_path: pathApi.join(installationDirectory, INTEGRATION_MANIFEST_FILE),
  };
}
