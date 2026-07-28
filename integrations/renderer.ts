import { createHash } from "node:crypto";
import { z } from "zod";
import { buildClientArtifactContents } from "../src/client-artifacts";
import {
  INTEGRATION_SKILL_IDS,
  integrationSkill,
  integrationSkillIdSchema,
  type IntegrationSkillId,
} from "../src/integration-skills";
import {
  INTEGRATION_AGENT_PROTOCOL_VERSION,
  INTEGRATION_BUNDLE_SCHEMA,
  INTEGRATION_BUNDLE_VERSION,
  INTEGRATION_CLIENT_IDS,
  integrationClient,
  integrationClientIdSchema,
} from "./clients";

export const CANONICAL_SKILL_PATHS = [
  "SKILL.md",
  "references/content-trust.md",
  "references/errors.md",
  "references/git-context.md",
  "references/project-context.md",
  "references/read-tasks.md",
  "references/write-tasks.md",
] as const;

export const INTEGRATION_SKILL_PATHS = {
  asana: CANONICAL_SKILL_PATHS,
  "asana-concepts": ["SKILL.md"],
  "asana-company-discovery": ["SKILL.md"],
  "asana-cli-insights": ["SKILL.md"],
} as const satisfies Record<IntegrationSkillId, readonly string[]>;

const portableSkillPathSchema = z
  .string()
  .regex(/^(?:SKILL\.md|references\/[a-z][a-z0-9-]*\.md)$/);
const portableSourceFileSchema = z.strictObject({
  path: portableSkillPathSchema,
  content: z.string().min(1),
});

export const portableSkillBundleSchema = z.strictObject({
  name: integrationSkillIdSchema,
  version: z.literal(INTEGRATION_BUNDLE_VERSION),
  agent_protocol_version: z.literal(INTEGRATION_AGENT_PROTOCOL_VERSION),
  files: z.array(portableSourceFileSchema).min(1),
}).superRefine((bundle, context) => {
  const expected = INTEGRATION_SKILL_PATHS[bundle.name];
  const paths = new Set(bundle.files.map((file) => file.path));
  for (const path of expected) {
    if (!paths.has(path)) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: `missing canonical skill file: ${path}`,
      });
    }
  }
  for (const path of paths) {
    if (!expected.includes(path as never)) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: `unexpected canonical skill file: ${path}`,
      });
    }
  }
});

const renderedFileSchema = z.strictObject({
  path: portableSkillPathSchema,
  content: z.string().min(1),
  sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

export const renderedIntegrationBundleSchema = z.strictObject({
  schema: z.literal(INTEGRATION_BUNDLE_SCHEMA),
  bundle_version: z.literal(INTEGRATION_BUNDLE_VERSION),
  agent_protocol_version: z.literal(INTEGRATION_AGENT_PROTOCOL_VERSION),
  client: integrationClientIdSchema,
  skill: integrationSkillIdSchema,
  display_name: z.string().min(1),
  description: z.string().min(1),
  install_roots: z.strictObject({ user: z.string(), project: z.string() }),
  entrypoint: z.literal("SKILL.md"),
  files: z.array(renderedFileSchema).min(1),
});

export type PortableSkillBundle = z.output<typeof portableSkillBundleSchema>;
export type RenderedIntegrationBundle = z.output<typeof renderedIntegrationBundleSchema>;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function normalizedContent(content: string): string {
  return `${content.replace(/\r\n?/g, "\n").replace(/\n*$/, "")}\n`;
}

export function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function installRoot(root: string, skill: IntegrationSkillId): string {
  const segments = root.split("/");
  if (segments.at(-1) !== "asana") {
    throw new Error(`Client skill root must end in asana: ${root}`);
  }
  segments[segments.length - 1] = skill;
  return segments.join("/");
}

/** Parses, canonicalizes line endings, and orders one portable source skill. */
export function portableSkillBundle(input: unknown): PortableSkillBundle {
  const parsed = portableSkillBundleSchema.parse(input);
  const expected = INTEGRATION_SKILL_PATHS[parsed.name];
  const byPath = Object.fromEntries(
    parsed.files.map((file) => [file.path, normalizedContent(file.content)]),
  ) as Record<string, string>;
  return portableSkillBundleSchema.parse({
    ...parsed,
    files: expected.map((path) => ({ path, content: byPath[path] })),
  });
}

/** Renders a client bundle without timestamps, environment input, or filesystem access. */
export function renderIntegrationBundle(
  clientInput: unknown,
  sourceInput: unknown,
): RenderedIntegrationBundle {
  const client = integrationClient(clientInput);
  const source = portableSkillBundle(sourceInput);
  const metadata = integrationSkill(source.name);
  const artifacts = buildClientArtifactContents(client.id, source.files);
  return renderedIntegrationBundleSchema.parse({
    schema: INTEGRATION_BUNDLE_SCHEMA,
    bundle_version: source.version,
    agent_protocol_version: source.agent_protocol_version,
    client: client.id,
    skill: source.name,
    display_name: metadata.display_name,
    description: metadata.description,
    install_roots: {
      user: installRoot(client.install_roots.user, source.name),
      project: installRoot(client.install_roots.project, source.name),
    },
    entrypoint: client.skill_entrypoint,
    files: source.files.map((file) => {
      const artifact = artifacts[file.path];
      if (!artifact) throw new Error(`Client artifact omitted canonical file: ${file.path}`);
      const content = utf8Decoder.decode(artifact);
      return { path: file.path, content, sha256: sha256(content) };
    }),
  });
}

export function renderIntegrationBundles(
  sourceInput: unknown,
): RenderedIntegrationBundle[] {
  const source = portableSkillBundle(sourceInput);
  return [...INTEGRATION_CLIENT_IDS]
    .sort()
    .map((client) => renderIntegrationBundle(client, source));
}

export function renderIntegrationSkillSet(
  sourceInputs: readonly unknown[],
): RenderedIntegrationBundle[] {
  const sources = sourceInputs.map(portableSkillBundle);
  const sourceById = new Map(sources.map((source) => [source.name, source]));
  for (const id of INTEGRATION_SKILL_IDS) {
    if (!sourceById.has(id)) throw new Error(`Missing embedded skill source: ${id}`);
  }
  if (sourceById.size !== INTEGRATION_SKILL_IDS.length) {
    throw new Error("Embedded skill source set contains duplicate skills");
  }
  return [...INTEGRATION_CLIENT_IDS].sort().flatMap((client) =>
    INTEGRATION_SKILL_IDS.map((skill) =>
      renderIntegrationBundle(client, sourceById.get(skill)),
    )
  );
}

/**
 * Generates the runtime module. Its output is deliberately self-contained: consumers
 * statically import the generated module, whose data contains every skill byte.
 */
export function renderEmbeddedBundleModule(sourceInputs: readonly unknown[]): string {
  const rendered = renderIntegrationSkillSet(sourceInputs);
  const clients = [...INTEGRATION_CLIENT_IDS].sort().map((client) => {
    const skills = rendered.filter((bundle) => bundle.client === client);
    const primary = skills.find((bundle) => bundle.skill === "asana");
    if (!primary) throw new Error(`Missing primary Asana skill for ${client}`);
    return { ...primary, skills };
  });
  const clientIds = JSON.stringify([...INTEGRATION_CLIENT_IDS].sort());
  const skillIds = JSON.stringify(INTEGRATION_SKILL_IDS);
  const payload = JSON.stringify({
    schema: INTEGRATION_BUNDLE_SCHEMA,
    bundle_version: INTEGRATION_BUNDLE_VERSION,
    agent_protocol_version: INTEGRATION_AGENT_PROTOCOL_VERSION,
    clients,
  }, null, 2);

  return `// Generated by scripts/generate-integrations.ts. DO NOT EDIT.\nimport { z } from "zod";\n\nconst sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);\nconst fileSchema = z.strictObject({\n  path: z.string().regex(/^(?:SKILL\\.md|references\\/[a-z][a-z0-9-]*\\.md)$/),\n  content: z.string().min(1),\n  sha256: sha256Schema,\n});\nconst clientIdSchema = z.enum(${clientIds});\nconst skillIdSchema = z.enum(${skillIds});\nconst skillBundleSchema = z.strictObject({\n  schema: z.literal("asana-cli.integration-bundle.v1"),\n  bundle_version: z.literal(${JSON.stringify(INTEGRATION_BUNDLE_VERSION)}),\n  agent_protocol_version: z.literal(${INTEGRATION_AGENT_PROTOCOL_VERSION}),\n  client: clientIdSchema,\n  skill: skillIdSchema,\n  display_name: z.string().min(1),\n  description: z.string().min(1),\n  install_roots: z.strictObject({ user: z.string(), project: z.string() }),\n  entrypoint: z.literal("SKILL.md"),\n  files: z.array(fileSchema).min(1),\n});\nconst clientBundleSchema = skillBundleSchema.extend({\n  skill: z.literal("asana"),\n  skills: z.array(skillBundleSchema).length(${INTEGRATION_SKILL_IDS.length}),\n});\nexport const embeddedIntegrationBundleSchema = z.strictObject({\n  schema: z.literal("asana-cli.integration-bundle.v1"),\n  bundle_version: z.literal(${JSON.stringify(INTEGRATION_BUNDLE_VERSION)}),\n  agent_protocol_version: z.literal(${INTEGRATION_AGENT_PROTOCOL_VERSION}),\n  clients: z.array(clientBundleSchema).length(${INTEGRATION_CLIENT_IDS.length}),\n});\n\nexport const EMBEDDED_INTEGRATION_BUNDLE = embeddedIntegrationBundleSchema.parse(${payload}) as Readonly<z.output<typeof embeddedIntegrationBundleSchema>>;\nexport type EmbeddedIntegrationClientId = z.output<typeof clientIdSchema>;\nexport type EmbeddedIntegrationSkillId = z.output<typeof skillIdSchema>;\nexport type EmbeddedIntegrationBundle = z.output<typeof skillBundleSchema>;\n\nexport function embeddedIntegrationBundle(client: unknown, skill: unknown = "asana"): EmbeddedIntegrationBundle {\n  const clientId = clientIdSchema.parse(client);\n  const skillId = skillIdSchema.parse(skill);\n  const clientBundle = EMBEDDED_INTEGRATION_BUNDLE.clients.find((candidate) => candidate.client === clientId);\n  const bundle = clientBundle?.skills.find((candidate) => candidate.skill === skillId);\n  if (!bundle) throw new Error(\`Embedded integration bundle missing: \${clientId}/\${skillId}\`);\n  return bundle;\n}\n`;
}
