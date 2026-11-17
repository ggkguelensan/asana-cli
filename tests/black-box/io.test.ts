import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFixture, removeFixture, runBinary } from "./harness";

describe("compiled JSON and file inputs", () => {
  test("materializes JSON from stdin and files with the same plain output", async () => {
    const fixture = await createFixture("asana-input-");
    const env = { ASANA_ACCESS_TOKEN: "OFFLINE_INPUT_TEST_TOKEN" };
    try {
      const input = '{"notes":"Release notes","completed":false}';
      const path = join(fixture.project, "update.json");
      await writeFile(path, input);
      const results = [];
      for (const value of [input, `@${path}`, "-"]) {
        const result = await runBinary(fixture, ["task", "update", "123", "--data", value, "--dry-run", "--compact"], { env, ...(value === "-" ? { stdin: input } : {}) });
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim().split("\n")).toHaveLength(1);
        results.push(JSON.parse(result.stdout));
      }
      expect(results[0]).toEqual(results[1]);
      expect(results[1]).toEqual(results[2]);
    } finally { await removeFixture(fixture); }
  });
  test("rejects invalid update data and conflicting dates", async () => {
    const fixture = await createFixture("asana-invalid-");
    try {
      for (const fields of [["--data", "[]"], ["--due-on", "2026-12-01", "--due-at", "2026-12-01T10:00:00Z"]]) {
        const result = await runBinary(fixture, ["task", "update", "123", ...fields, "--dry-run"], { env: { ASANA_ACCESS_TOKEN: "OFFLINE_INVALID_INPUT_TOKEN" } });
        expect(result.exitCode).toBe(2);
        expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "validation" } });
      }
    } finally { await removeFixture(fixture); }
  });
});
