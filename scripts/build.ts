import { generateIntegrationBundle } from "./generate-integrations";
import { parseRequestedBuildTarget } from "./check-support-matrix";

await generateIntegrationBundle();

const [rawTarget, requestedOutput, ...unexpectedArguments] = process.argv.slice(2);
if (unexpectedArguments.length > 0) {
  throw new Error("Usage: bun run build [supported-target output-path]");
}
if ((rawTarget === undefined) !== (requestedOutput === undefined)) {
  throw new Error("A cross-compile target and output path must be provided together");
}
const target = parseRequestedBuildTarget(rawTarget);
const outfile = requestedOutput ?? "dist/asana-cli";

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  compile: {
    ...(target ? { target } : {}),
    outfile,
    autoloadDotenv: false,
    autoloadBunfig: false,
    autoloadTsconfig: false,
    autoloadPackageJson: false,
  },
  minify: false,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log(`Built ${outfile}${target ? ` for ${target}` : ""}`);
