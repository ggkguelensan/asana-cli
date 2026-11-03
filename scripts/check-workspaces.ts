import { resolve } from "node:path";
import { z } from "zod";
import { bunLockBaseShape, dependencyMapSchema } from "./dependency-manifest";

const root = resolve(import.meta.dir, "..");
const manifestSchema = z.looseObject({
  name: z.string(), dependencies: dependencyMapSchema.default({}),
  devDependencies: dependencyMapSchema.default({}),
});
const lockSchema = z.looseObject({
  ...bunLockBaseShape,
  workspaces: z.record(z.string(), manifestSchema),
});
const lock = lockSchema.parse(Bun.JSONC.parse(await Bun.file(resolve(root, "bun.lock")).text()));
const entries = await Promise.all(Object.entries(lock.workspaces).map(async ([path, locked]) => {
  const actual = manifestSchema.parse(await Bun.file(resolve(root, path, "package.json")).json());
  const canonical = (value: Record<string, string>) => JSON.stringify(Object.entries(value).sort());
  for (const field of ["dependencies", "devDependencies"] as const) {
    if (canonical(actual[field]) !== canonical(locked[field])) throw new Error(`Stale lockfile: ${path}/${field}`);
  }
  if (actual.name !== locked.name) throw new Error(`Workspace name mismatch: ${path}`);
  return [actual.name, actual.dependencies] as const;
}));
const graph = new Map(entries);
function requireWorkspace(name: string, version: string): void {
  if (version.startsWith("workspace:") && !graph.has(name)) throw new Error(`Missing workspace ${name}`);
}
function dependenciesOf(name: string): string[] {
  const entries = Object.entries(graph.get(name) ?? {});
  for (const [dependency, version] of entries) {
    requireWorkspace(dependency, version);
  }
  return entries.map(([dependency]) => dependency);
}
function reachable(name: string, seen = new Set<string>()): Set<string> {
  if (seen.has(name)) return seen;
  seen.add(name);
  for (const dependency of dependenciesOf(name)) reachable(dependency, seen);
  return seen;
}
for (const name of ["@asana-cli/contracts", "@asana-cli/web"]) {
  const dependencies = reachable(name);
  for (const forbidden of ["asana", "@asana-cli/asana-client", "@asana-cli/local-runtime", "@asana-cli/cli"]) {
    if (dependencies.has(forbidden)) throw new Error(`${name} must not depend on ${forbidden}`);
  }
}
const transport = reachable("@asana-cli/asana-client");
if (transport.has("@asana-cli/cli") || transport.has("@asana-cli/web")) {
  throw new Error("Asana adapter must not depend on applications");
}
process.stdout.write(`Workspace manifests and browser/server boundaries verified: ${entries.length - 1} packages\n`);
