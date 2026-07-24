import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { readCanonicalSkillSource } from "./generate-integrations";
import { CLI_VERSION } from "../src/version";

const projectRoot = resolve(import.meta.dir, "..");
export const GENERATED_GEMINI_EXTENSION_ROOT = resolve(
  projectRoot,
  "generated/gemini-extension",
);

export async function renderGeminiExtensionFiles(): Promise<Readonly<Record<string, string>>> {
  const source = await readCanonicalSkillSource();
  const manifest = {
    name: "asana-cli",
    version: CLI_VERSION,
    description: "Safe direct Asana workflows through the curated asana-cli agent protocol.",
  };
  return {
    "gemini-extension.json": `${JSON.stringify(manifest, null, 2)}\n`,
    ...Object.fromEntries(
      source.files.map((file) => [`skills/asana/${file.path}`, file.content]),
    ),
  };
}

export async function generateGeminiExtension(
  options: Readonly<{ write?: boolean }> = {},
): Promise<Readonly<Record<string, string>>> {
  const files = await renderGeminiExtensionFiles();
  if (options.write !== false) {
    await rm(GENERATED_GEMINI_EXTENSION_ROOT, { recursive: true, force: true });
    for (const [relativePath, content] of Object.entries(files)) {
      const output = resolve(GENERATED_GEMINI_EXTENSION_ROOT, relativePath);
      await mkdir(dirname(output), { recursive: true });
      await Bun.write(output, content);
    }
  }
  return files;
}

if (import.meta.main) {
  await generateGeminiExtension();
  process.stdout.write("Generated generated/gemini-extension\n");
}
