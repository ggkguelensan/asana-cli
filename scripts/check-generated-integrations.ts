import {
  GENERATED_INTEGRATION_BUNDLE_PATH,
  renderGeneratedIntegrationBundle,
} from "./generate-integrations";

const expected = await renderGeneratedIntegrationBundle();
const generated = Bun.file(GENERATED_INTEGRATION_BUNDLE_PATH);
if (!(await generated.exists())) {
  throw new Error("Generated integration bundle is missing; run bun run generate:integrations");
}

if (await generated.text() !== expected) {
  throw new Error("Generated integration bundle drifted; run bun run generate:integrations");
}

process.stdout.write("Generated integration bundle is current\n");
