import { z } from "zod";
import { GENERATED_CLIENT_COMPATIBILITY } from "../generated/client-compatibility";
import {
  CLIENT_ADAPTERS,
  CLIENT_ADAPTER_IDS,
  clientAdapter,
  clientAdapterIdSchema,
  parseClientAdapterId,
} from "../src/client-adapter-specs";
import { AGENT_PROTOCOL_COMPATIBILITY, AGENT_PROTOCOL_VERSION } from "../src/version";

export const INTEGRATION_BUNDLE_SCHEMA = "asana-cli.integration-bundle.v1" as const;
export const INTEGRATION_BUNDLE_VERSION = "1.0.0" as const;
export const INTEGRATION_AGENT_PROTOCOL_VERSION = AGENT_PROTOCOL_VERSION;

const portableRelativePathSchema = z.string()
  .min(1)
  .max(240)
  .regex(/^(?!\/)(?!.*(?:^|\/)\.\.?\/)[A-Za-z0-9._/-]+$/, "must be a portable relative path")
  .refine((path) => !path.includes("//"), "must not contain empty path segments");

export const integrationClientIdSchema = clientAdapterIdSchema;
export const integrationScopeSchema = z.enum(["user", "project"]);

const supportLevelSchema = z.enum(["generic", "experimental", "supported"]);
const qualificationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("generic-contract"),
    evidence: z.null(),
    evidence_sha256: z.null(),
  }),
  z.strictObject({
    kind: z.literal("behavioral-eval"),
    evidence: z.string().regex(/^evidence\/client-evals\/[a-z-]+\.json$/),
    evidence_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({
    kind: z.literal("adapter-only"),
    evidence: z.union([
      z.string().regex(/^evidence\/client-adapters\/[a-z-]+\.json$/),
      z.null(),
    ]),
    evidence_sha256: z.union([
      z.string().regex(/^[a-f0-9]{64}$/),
      z.null(),
    ]),
  }).refine(
    (qualification) =>
      (qualification.evidence === null) ===
      (qualification.evidence_sha256 === null),
    "adapter evidence path and digest must both be present or absent",
  ),
]);
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
  qualification: qualificationSchema,
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

const registryDefinition = Object.fromEntries(CLIENT_ADAPTERS.map((definition) => {
  const adapter = clientAdapter(parseClientAdapterId(definition.id));
  const compatibility = GENERATED_CLIENT_COMPATIBILITY.clients[adapter.id];
  return [adapter.id, {
    id: adapter.id,
    label: adapter.displayName,
    support: compatibility.support,
    qualification: compatibility.qualification,
    protocol: AGENT_PROTOCOL_COMPATIBILITY,
    install_roots: {
      user: adapter.roots.user.join("/"),
      project: adapter.roots.project.join("/"),
    },
    skill_entrypoint: "SKILL.md" as const,
  }];
}));

export const INTEGRATION_CLIENTS = integrationClientRegistrySchema.parse(registryDefinition);
export const INTEGRATION_CLIENT_IDS = CLIENT_ADAPTER_IDS;

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
