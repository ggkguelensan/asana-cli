import { describe, expect, test } from "bun:test";
import { runCli } from "../src/cli";

describe("Asana CLI manual", () => {
  test("provides offline help, glossary and SDK examples", async () => {
    for (const args of [["--help"], ["man"], ["man", "start"], ["man", "glossary"], ["man", "examples"], ["man", "auth"]]) {
      const result = await runCli(args);
      expect(result.text?.length).toBeGreaterThan(30);
      expect(result.text).not.toMatch(/--agents|agent-setup|Worktrunk|integrations install/);
    }
    expect((await runCli(["man", "examples"])).text).toContain("NotificationsApi");
  });
  test("rejects obsolete topics", async () => {
    await expect(runCli(["man", "agents"])).rejects.toThrow("Unknown manual topic");
  });
});
