import {
  GENERATED_CLIENT_COMPATIBILITY_MARKDOWN_PATH,
  GENERATED_CLIENT_COMPATIBILITY_PATH,
  renderClientCompatibilityMarkdown,
  renderClientCompatibilityModule,
} from "./generate-client-compatibility";

const expected = await renderClientCompatibilityModule();
const generated = Bun.file(GENERATED_CLIENT_COMPATIBILITY_PATH);
if (!(await generated.exists())) {
  throw new Error(
    "Generated client compatibility is missing; run bun run generate:client-compatibility",
  );
}
if (await generated.text() !== expected) {
  throw new Error(
    "Generated client compatibility drifted; run bun run generate:client-compatibility",
  );
}
const expectedMarkdown = await renderClientCompatibilityMarkdown();
const generatedMarkdown = Bun.file(GENERATED_CLIENT_COMPATIBILITY_MARKDOWN_PATH);
if (!(await generatedMarkdown.exists())) {
  throw new Error(
    "Generated client compatibility Markdown is missing; run bun run generate:client-compatibility",
  );
}
if (await generatedMarkdown.text() !== expectedMarkdown) {
  throw new Error(
    "Generated client compatibility Markdown drifted; run bun run generate:client-compatibility",
  );
}

process.stdout.write("Generated client compatibility is current\n");
