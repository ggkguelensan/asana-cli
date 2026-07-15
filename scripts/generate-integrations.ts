import { resolve } from "node:path";
import {
  CANONICAL_SKILL_PATHS,
  portableSkillBundle,
  renderEmbeddedBundleModule,
  type PortableSkillBundle,
} from "../integrations/renderer";
import {
  INTEGRATION_AGENT_PROTOCOL_VERSION,
  INTEGRATION_BUNDLE_VERSION,
} from "../integrations/clients";

const projectRoot = resolve(import.meta.dir, "..");
const sourceRoot = resolve(projectRoot, "skills/source/asana");
export const GENERATED_INTEGRATION_BUNDLE_PATH = resolve(
  projectRoot,
  "generated/integrations/bundle.ts",
);

export async function readCanonicalSkillSource(): Promise<PortableSkillBundle> {
  const files = await Promise.all(CANONICAL_SKILL_PATHS.map(async (path) => {
    const file = Bun.file(resolve(sourceRoot, path));
    if (!(await file.exists())) {
      throw new Error(`Canonical skill source is missing required file: ${path}`);
    }
    return { path, content: await file.text() };
  }));

  return portableSkillBundle({
    name: "asana",
    version: INTEGRATION_BUNDLE_VERSION,
    agent_protocol_version: INTEGRATION_AGENT_PROTOCOL_VERSION,
    files,
  });
}

export async function renderGeneratedIntegrationBundle(): Promise<string> {
  return renderEmbeddedBundleModule(await readCanonicalSkillSource());
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
