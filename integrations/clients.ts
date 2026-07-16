import { z } from "zod";
import {
  clientAdapter,
  parseClientAdapterId,
} from "../src/client-adapter-specs";
import { AGENT_PROTOCOL_COMPATIBILITY, AGENT_PROTOCOL_VERSION } from "../src/version";

export const INTEGRATION_BUNDLE_SCHEMA = "asana-cli.integration-bundle.v1" as const;
export const INTEGRATION_BUNDLE_VERSION = "0.4.0" as const;
export const INTEGRATION_AGENT_PROTOCOL_VERSION = AGENT_PROTOCOL_VERSION;

const portableRelativePathSchema = z.string()
  .min(1)
  .max(240)
  .regex(/^(?!\/)(?!.*(?:^|\/)\.\.?\/)[A-Za-z0-9._/-]+$/, "must be a portable relative path")
  .refine((path) => !path.includes("//"), "must not contain empty path segments");

export const integrationClientIdSchema = z.enum([
  "generic-agent-skills",
  "codex",
  "claude-code",
]);
export const integrationScopeSchema = z.enum(["user", "project"]);

const supportLevelSchema = z.enum(["generic", "supported"]);
const protocolCompatibilitySchema = z.strictObject({
  minimum: z.literal(AGENT_PROTOCOL_COMPATIBILITY.minimum),
  maximum: z.literal(AGENT_PROTOCOL_COMPATIBILITY.maximum),
});
const installRootsSchema = z.strictObject({
  user: portableRelativePathSchema,
  project: portableRelativePathSchema,
});

export const integrationClientSchema = z.strictObject({
  id: integrationClientIdSchema,
  label: z.string().min(1).max(80),
  support: supportLevelSchema,
  protocol: protocolCompatibilitySchema,
  install_roots: installRootsSchema,
  skill_entrypoint: z.literal("SKILL.md"),
});

export const integrationClientRegistrySchema = z.record(
  integrationClientIdSchema,
  integrationClientSchema,
).superRefine((registry, context) => {
  for (const [id, client] of Object.entries(registry)) {
    if (id !== client.id) {
      context.addIssue({
        code: "custom",
        path: [id, "id"],
        message: "registry key must match client id",
      });
    }
  }
});

const genericAdapter = clientAdapter(parseClientAdapterId("generic-agent-skills"));
const codexAdapter = clientAdapter(parseClientAdapterId("codex"));
const claudeAdapter = clientAdapter(parseClientAdapterId("claude-code"));

const registryDefinition = {
  "generic-agent-skills": {
    id: "generic-agent-skills",
    label: genericAdapter.displayName,
    support: "generic",
    protocol: AGENT_PROTOCOL_COMPATIBILITY,
    install_roots: {
      user: genericAdapter.roots.user.join("/"),
      project: genericAdapter.roots.project.join("/"),
    },
    skill_entrypoint: "SKILL.md",
  },
  codex: {
    id: "codex",
    label: codexAdapter.displayName,
    support: "supported",
    protocol: AGENT_PROTOCOL_COMPATIBILITY,
    install_roots: {
      user: codexAdapter.roots.user.join("/"),
      project: codexAdapter.roots.project.join("/"),
    },
    skill_entrypoint: "SKILL.md",
  },
  "claude-code": {
    id: "claude-code",
    label: claudeAdapter.displayName,
    support: "supported",
    protocol: AGENT_PROTOCOL_COMPATIBILITY,
    install_roots: {
      user: claudeAdapter.roots.user.join("/"),
      project: claudeAdapter.roots.project.join("/"),
    },
    skill_entrypoint: "SKILL.md",
  },
} as const;

export const INTEGRATION_CLIENTS = integrationClientRegistrySchema.parse(registryDefinition);
export const INTEGRATION_CLIENT_IDS = integrationClientIdSchema.options;

export type IntegrationClientId = z.output<typeof integrationClientIdSchema>;
export type IntegrationScope = z.output<typeof integrationScopeSchema>;
export type IntegrationClient = z.output<typeof integrationClientSchema>;

export function integrationClient(input: unknown): IntegrationClient {
  const id = integrationClientIdSchema.parse(input);
  return INTEGRATION_CLIENTS[id];
}

export function integrationInstallRoot(input: unknown, scope: unknown): string {
  return integrationClient(input).install_roots[integrationScopeSchema.parse(scope)];
}
