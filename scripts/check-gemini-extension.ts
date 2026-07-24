import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  GENERATED_GEMINI_EXTENSION_ROOT,
  renderGeminiExtensionFiles,
} from "./generate-gemini-extension";

async function filesBelow(directory: string): Promise<string[]> {
  const found: string[] = [];
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const nested = resolve(path, entry.name);
      if (entry.isDirectory()) await visit(nested);
      else if (entry.isFile() && !entry.isSymbolicLink()) {
        found.push(relative(directory, nested).split(sep).join("/"));
      } else {
        throw new Error("Generated Gemini extension contains a non-regular entry");
      }
    }
  }
  await visit(directory);
  return found.sort();
}

const expected = await renderGeminiExtensionFiles();
const actualPaths = await filesBelow(GENERATED_GEMINI_EXTENSION_ROOT);
const expectedPaths = Object.keys(expected).sort();
if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
  throw new Error("Generated Gemini extension paths drifted; run bun run generate:gemini-extension");
}
for (const path of expectedPaths) {
  if (await readFile(resolve(GENERATED_GEMINI_EXTENSION_ROOT, path), "utf8") !== expected[path]) {
    throw new Error(`Generated Gemini extension file drifted: ${path}`);
  }
}
const manifest = JSON.parse(expected["gemini-extension.json"]!) as Record<string, unknown>;
for (const prohibited of ["mcpServers", "settings", "hooks"]) {
  if (prohibited in manifest) {
    throw new Error(`Gemini extension must not declare ${prohibited}`);
  }
}

process.stdout.write("Generated Gemini extension is current and contains no MCP declaration\n");
