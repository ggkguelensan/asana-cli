import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const suiteDirectory = join(projectRoot, "tests", "black-box");
const prohibitedImport = /from\s+["'][^"']*(?:src|scripts|generated|integrations)\//;
const prohibitedExecution = /(?:src\/index\.ts|process\.execPath\s*,\s*["']run["'])/;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const files = (await readdir(suiteDirectory))
  .filter((file) => file.endsWith(".ts"))
  .sort();
const testFiles = files.filter((file) => file.endsWith(".test.ts"));
assert(testFiles.length >= 4, "Black-box suite must retain at least four independent test modules");
assert(files.includes("harness.ts"), "Black-box suite is missing its process harness");

for (const file of files) {
  const source = await readFile(join(suiteDirectory, file), "utf8");
  assert(
    !prohibitedImport.test(source),
    `Black-box test ${file} imports implementation or generated source`,
  );
  assert(
    !prohibitedExecution.test(source),
    `Black-box test ${file} executes the TypeScript entrypoint instead of the compiled binary`,
  );
  if (file.endsWith(".test.ts")) {
    assert(
      source.includes('from "./harness"'),
      `Black-box test ${file} must use the shared compiled-binary harness`,
    );
  }
}

const harness = await readFile(join(suiteDirectory, "harness.ts"), "utf8");
assert(
  harness.includes('join(projectRoot, "dist", "asana-cli")'),
  "Black-box harness must execute dist/asana-cli",
);
assert(harness.includes("Bun.spawn({"), "Black-box harness must cross a process boundary");

const packageManifest = JSON.parse(
  await readFile(join(projectRoot, "package.json"), "utf8"),
) as { scripts?: Record<string, string> };
assert(
  packageManifest.scripts?.["test:black-box"] ===
    "bun run build && bun test tests/black-box",
  "package.json must expose the standalone compiled black-box suite",
);
assert(
  packageManifest.scripts?.check?.includes("bun run check:black-box-boundary"),
  "The full check must enforce black-box source isolation",
);

process.stdout.write(
  `Black-box boundary verified: ${testFiles.length} suites use only dist/asana-cli\n`,
);
