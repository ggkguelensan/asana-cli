import { describe, expect, test } from "bun:test";
import { createFixture, removeFixture, runBinary, successfulJson, record } from "./harness";

describe("compiled Asana CLI public interface", () => {
  test("offers static SDK discovery and documentation without authentication", async () => {
    const fixture = await createFixture("asana-contract-");
    try {
      const classes = record(await successfulJson(fixture, ["api", "list"]), "APIs").classes;
      expect(classes).toContain("TasksApi");
      expect(classes).toContain("NotificationsApi");
      expect(classes).toContain("TablesApi");
      expect(classes).toContain("RecordsApi");
      for (const name of ["NotificationsApi", "TablesApi", "RecordsApi"]) {
        const methods = record(await successfulJson(fixture, ["api", "list", name]), name);
        expect(methods.class).toBe(name);
        expect(Array.isArray(methods.methods)).toBe(true);
      }
      const docs = record(await successfulJson(fixture, ["api", "docs", "NotificationsApi", "getNotificationsForUser"]), "docs");
      expect(docs.url).toContain("NotificationsApi.md#getNotificationsForUser");
      const help = await runBinary(fixture, ["--help"]);
      expect(help.exitCode).toBe(0);
      expect(help.stdout).toContain("task search");
      expect(help.stdout).not.toMatch(/agent-setup|--agents|integrations install|worktree/);
    } finally { await removeFixture(fixture); }
  });
  test("has plain JSON errors and rejects SDK HTTP response methods", async () => {
    const fixture = await createFixture("asana-errors-");
    try {
      const result = await runBinary(fixture, ["api", "docs", "TasksApi", "getTaskWithHttpInfo"]);
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "usage" } });
      expect(JSON.parse(result.stderr).result).toBeUndefined();
    } finally { await removeFixture(fixture); }
  });
});
