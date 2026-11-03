import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Generated baselines contain only findings from this pre-monorepo source.
const source = "c86fdc081319d1c6f250b6dd2b15b5ed28240f94";
const root = resolve(import.meta.dir, "..");
const reference = await mkdtemp(resolve(root, "../asana-cli-quality-reference-"));
function relocate(value: string): string {
  return value.replaceAll('"src/', '"apps/cli/src/').replaceAll('|src/', '|apps/cli/src/')
    .replaceAll('"web/', '"apps/web/').replaceAll('|web/', '|apps/web/');
}
try {
  const archive = resolve(reference, "source.tar");
  await Bun.$`git -C ${root} archive -o ${archive} ${source}`.quiet();
  await Bun.$`tar -xf ${archive} -C ${reference}`.quiet();
  const fallow = resolve(root, "node_modules/.bin/fallow");
  for (const analysis of ["health", "dupes"]) {
    const output = resolve(reference, `${analysis}.json`);
    const result = await Bun.$`${fallow} --root ${reference} ${analysis} --save-baseline ${output}`.quiet().nothrow();
    if (result.exitCode > 1) throw new Error(`Fallow ${analysis} failed: ${result.stderr}`);
    const value = JSON.parse(relocate(await readFile(output, "utf8"))) as Record<string, unknown>;
    if (Object.keys(value).length === 0) throw new Error("Empty baseline output");
    if (Array.isArray(value.clone_groups)) {
      if (value.clone_groups.length === 0) throw new Error("Historical duplication findings are missing");
      value.clone_groups = value.clone_groups.map((group: string) => group.split("|").sort().join("|")).sort();
    }
    await writeFile(resolve(root, `.fallow-${analysis}-baseline.json`), `${JSON.stringify(value, null, 2)}\n`);
  }
  const original = await readFile(resolve(reference, ".fallow-dead-code-baseline.json"), "utf8");
  await writeFile(resolve(root, ".fallow-dead-code-baseline.json"), relocate(original));
} finally { await rm(reference, { recursive: true, force: true }); }
process.stdout.write(`Migrated Fallow baseline paths from ${source}; no current findings accepted\n`);
