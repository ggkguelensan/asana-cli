import { resolve } from "node:path";
import {
  INTEGRATION_SKILL_PATHS,
  portableSkillBundle,
  renderEmbeddedBundleModule,
  type PortableSkillBundle,
} from "../integrations/renderer";
import {
  INTEGRATION_AGENT_PROTOCOL_VERSION,
  INTEGRATION_BUNDLE_VERSION,
} from "../integrations/clients";
import {
  INTEGRATION_SKILL_IDS,
  type IntegrationSkillId,
} from "../src/integration-skills";

const projectRoot = resolve(import.meta.dir, "..");
const sourceRoot = resolve(projectRoot, "skills/source");
export const GENERATED_INTEGRATION_BUNDLE_PATH = resolve(
  projectRoot,
  "generated/integrations/bundle.ts",
);

export async function readIntegrationSkillSource(
  skill: IntegrationSkillId,
): Promise<PortableSkillBundle> {
  const files = await Promise.all(INTEGRATION_SKILL_PATHS[skill].map(async (path) => {
    const file = Bun.file(resolve(sourceRoot, skill, path));
    if (!(await file.exists())) {
      throw new Error(`Embedded skill source is missing required file: ${skill}/${path}`);
    }
    return { path, content: await file.text() };
  }));

  return portableSkillBundle({
    name: skill,
    version: INTEGRATION_BUNDLE_VERSION,
    agent_protocol_version: INTEGRATION_AGENT_PROTOCOL_VERSION,
    files,
  });
}

export function readCanonicalSkillSource(): Promise<PortableSkillBundle> {
  return readIntegrationSkillSource("asana");
}

export async function readIntegrationSkillSources(): Promise<PortableSkillBundle[]> {
  return Promise.all(INTEGRATION_SKILL_IDS.map(readIntegrationSkillSource));
}

export async function renderGeneratedIntegrationBundle(): Promise<string> {
  return renderEmbeddedBundleModule(await readIntegrationSkillSources());
}

export async function generateIntegrationBundle(options: { write?: boolean } = {}): Promise<string> {
  const output = await renderGeneratedIntegrationBundle();
  if (options.write !== false) {
    const current = Bun.file(GENERATED_INTEGRATION_BUNDLE_PATH);
    if (!(await current.exists()) || await current.text() !== output) {
      await Bun.write(GENERATED_INTEGRATION_BUNDLE_PATH, output);
    }
  }
  return output;
}

if (import.meta.main) {
  await generateIntegrationBundle();
  process.stdout.write("Generated generated/integrations/bundle.ts\n");
}
