import { projectFiles } from "./source-files";

const roots = ["apps", "packages", "tests", "scripts"];
const forbidden = [
  /:\s*any\b/,
  /\bas\s+any\b/,
  /<any>/,
  /Promise\s*<\s*any\s*>/,
  /Record\s*<[^>]*,\s*any\s*>/,
];

const violations: string[] = [];
const sources = (await projectFiles()).filter((path) =>
  roots.some((root) => path.startsWith(`${root}/`)) && /\.tsx?$/.test(path));
for (const path of sources) {
  if (path === "scripts/check-types.ts") continue;
  const lines = (await Bun.file(path).text()).split("\n");
  for (const [index, line] of lines.entries()) {
    if (forbidden.some((pattern) => pattern.test(line))) {
      violations.push(`${path}:${index + 1}: ${line.trim()}`);
    }
  }
}

if (violations.length) {
  process.stderr.write(`Explicit unsafe types found:\n${violations.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write("No explicit any types found\n");
