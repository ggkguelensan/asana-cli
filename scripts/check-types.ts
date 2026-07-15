export {};

const roots = ["src", "tests", "scripts"];
const forbidden = [
  /:\s*any\b/,
  /\bas\s+any\b/,
  /<any>/,
  /Promise\s*<\s*any\s*>/,
  /Record\s*<[^>]*,\s*any\s*>/,
];

const violations: string[] = [];
for (const root of roots) {
  const glob = new Bun.Glob("**/*.ts");
  for await (const relativePath of glob.scan({ cwd: root })) {
    const path = `${root}/${relativePath}`;
    if (path === "scripts/check-types.ts") continue;
    const lines = (await Bun.file(path).text()).split("\n");
    for (const [index, line] of lines.entries()) {
      if (forbidden.some((pattern) => pattern.test(line))) {
        violations.push(`${path}:${index + 1}: ${line.trim()}`);
      }
    }
  }
}

if (violations.length) {
  process.stderr.write(`Explicit unsafe types found:\n${violations.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write("No explicit any types found\n");
