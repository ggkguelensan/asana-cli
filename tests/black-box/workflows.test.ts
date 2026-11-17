import { describe, expect, test } from "bun:test";
import { createFixture, removeFixture, runBinary, successfulJson } from "./harness";

describe("compiled Asana task workflows", () => {
  test("previews task updates and comments without sending requests", async () => {
    const fixture = await createFixture("asana-write-");
    const env = { ASANA_ACCESS_TOKEN: "OFFLINE_WORKFLOW_TEST_TOKEN" };
    try {
      const update = await runBinary(fixture, ["task", "update", "https://app.asana.com/0/123/456", "--completed=true", "--dry-run"], { env });
      expect(update.exitCode).toBe(0);
      expect(JSON.parse(update.stdout)).toMatchObject({ dry_run: true, task_gid: "456", body: { data: { completed: true } } });
      const comment = await runBinary(fixture, ["task", "comment", "456", "Comment content", "--dry-run"], { env });
      expect(comment.exitCode).toBe(0);
      expect(JSON.parse(comment.stdout)).toMatchObject({ operation: "StoriesApi.createStoryForTask", body: { data: { text: "Comment content" } } });
    } finally { await removeFixture(fixture); }
  });
  test("offline doctor performs no release or journal checks", async () => {
    const fixture = await createFixture("asana-doctor-");
    try {
      const result = await successfulJson(fixture, ["doctor", "--offline"], { env: { ASANA_ACCESS_TOKEN: "OFFLINE_DOCTOR_TEST_TOKEN" } });
      expect(result).toMatchObject({ offline: true, checks: [
        { id: "runtime" }, { id: "path" }, { id: "authentication", status: "skipped" },
      ] });
    } finally { await removeFixture(fixture); }
  });
});
