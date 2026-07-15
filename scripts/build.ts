import { generateIntegrationBundle } from "./generate-integrations";

await generateIntegrationBundle();

const [rawTarget, requestedOutput] = process.argv.slice(2);
const target = rawTarget as Bun.Build.CompileTarget | undefined;
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
