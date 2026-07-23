import { z } from "zod";

export const INTEGRATION_MANIFEST_SCHEMA = "asana-cli.integration-manifest.v1" as const;
export const INTEGRATION_MANIFEST_FILE = ".asana-cli-integration.json" as const;
export const INTEGRATION_INSTALLER = "asana-cli" as const;

export const integrationClientSchema = z.enum([
  "generic-agent-skills",
  "codex",
  "claude-code",
]);
export type IntegrationClient = z.output<typeof integrationClientSchema>;

export const integrationScopeSchema = z.enum(["user", "project"]);
export type IntegrationScope = z.output<typeof integrationScopeSchema>;

const protectedPathSegments: Record<string, true> = {
  "agents.md": true,
  "claude.md": true,
  hooks: true,
  settings: true,
  "settings.json": true,
  config: true,
  "config.json": true,
  [INTEGRATION_MANIFEST_FILE]: true,
};

function isSafeArtifactPath(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 512 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    return false;
  }

  return value.split("/").every((segment) =>
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    protectedPathSegments[segment.toLowerCase()] !== true
  );
}

export const integrationArtifactPathSchema = z.string().refine(
  isSafeArtifactPath,
  "artifact path must be a relative, non-protected POSIX path",
);

export const MAX_INTEGRATION_ARTIFACT_BYTES = 2 * 1024 * 1024;
export const MAX_INTEGRATION_MANIFEST_BYTES = 256 * 1024;

export const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/, "expected sha256:<lowercase-hex>");

export const integrationArtifactContentsSchema = z.record(
  integrationArtifactPathSchema,
  z.string().max(MAX_INTEGRATION_ARTIFACT_BYTES, "artifact content exceeds 2 MiB"),
).refine((files) => Object.keys(files).length > 0, "at least one artifact is required");
export type IntegrationArtifactContents = z.output<typeof integrationArtifactContentsSchema>;

export const integrationManifestSchema = z.strictObject({
  schema: z.literal(INTEGRATION_MANIFEST_SCHEMA),
  installer: z.literal(INTEGRATION_INSTALLER),
  cli_version: z.string().min(1).max(128),
  agent_protocol_version: z.number().int().positive(),
  client: integrationClientSchema,
  scope: integrationScopeSchema,
  files: z.record(integrationArtifactPathSchema, sha256Schema).refine(
    (files) => Object.keys(files).length > 0,
    "manifest must own at least one artifact",
  ),
});
export type IntegrationManifest = z.output<typeof integrationManifestSchema>;

export const integrationTargetInputSchema = z.strictObject({
  client: integrationClientSchema,
  scope: integrationScopeSchema,
  home_directory: z.string().min(1).optional(),
  project_directory: z.string().min(1).optional(),
});
export type IntegrationTargetInput = z.output<typeof integrationTargetInputSchema>;

export const integrationBundleInputSchema = z.strictObject({
  target: integrationTargetInputSchema,
  cli_version: z.string().min(1).max(128),
  agent_protocol_version: z.number().int().positive(),
  files: integrationArtifactContentsSchema,
});
export type IntegrationBundleInput = z.output<typeof integrationBundleInputSchema>;

export const integrationDoctorInputSchema = z.strictObject({
  target: integrationTargetInputSchema,
  environment: z.record(z.string(), z.string().optional()).optional(),
  probe_credential_store: z.boolean().default(true),
  auto_allow_commands: z
    .array(z.string().trim().min(1).max(1_024))
    .max(100)
    .refine((commands) => new Set(commands).size === commands.length, "auto-allow commands must be unique")
    .default([]),
});
export type IntegrationDoctorInput = z.output<typeof integrationDoctorInputSchema>;
