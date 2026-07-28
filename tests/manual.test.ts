import { describe, expect, test } from "bun:test";
import { runCli } from "../src/cli";

describe("concise help and embedded manual", () => {
  test("advertises --agents as the first agent entrypoint", async () => {
    const result = await runCli(["--help"]);
    expect(result.text).toContain("asana-cli --agents");
    expect(result.text).toContain("Первая точка входа для любого агента");
    expect(result.text).toContain("asana-cli man [TOPIC]");
  });

  test("publishes an index, glossary, examples, and guidebooks without auth", async () => {
    const index = await runCli(["man"]);
    expect(index.text).toContain("asana-cli man glossary");
    expect(index.text).toContain("asana-cli man examples");
    expect(index.text).toContain("asana-cli man agents");
    expect(index.text).toContain("asana-cli man company");

    const glossary = await runCli(["man", "glossary"]);
    expect(glossary.text).toContain("Workspace");
    expect(glossary.text).toContain("Custom field");

    const agents = await runCli(["man", "agents"]);
    expect(agents.text).toContain("asana-cli --agents");
    expect(agents.text).toContain("--scope project");
  });
});
