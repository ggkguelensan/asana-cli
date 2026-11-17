import { describe, expect, test } from "bun:test";
import { createFixture, removeFixture, runBinary, allFilesystemEntries } from "./harness";

describe("compiled credential and scope boundary", () => {
  test("rejects removed interfaces before credentials or filesystem mutations", async () => {
    const fixture = await createFixture("asana-scope-");
    try {
      const before = await allFilesystemEntries(fixture.root);
      for (const args of [["agent"], ["agent-setup"], ["integrations"], ["context"], ["insights"], ["update"], ["--agents"], ["me", "--agent"], ["task", "search-git", "ref"]]) {
        const result = await runBinary(fixture, args);
        expect(result.exitCode).toBe(2);
        expect(result.stdout).toBe("");
        expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "usage" } });
      }
      expect(await allFilesystemEntries(fixture.root)).toEqual(before);
    } finally { await removeFixture(fixture); }
  });
  test("redacts credentials and refuses disabled TLS", async () => {
    const fixture = await createFixture("asana-secret-");
    try {
      const token = "COMPILED_SECRET_CANARY_123456";
      const preview = await runBinary(fixture, ["task", "update", "123", "--notes", token, "--dry-run"], { env: { ASANA_ACCESS_TOKEN: token } });
      expect(preview.exitCode).toBe(0);
      expect(preview.stdout).not.toContain(token);
      expect(preview.stdout).toContain("REDACTED");
      const tls = await runBinary(fixture, ["me"], { env: { NODE_TLS_REJECT_UNAUTHORIZED: "0", ASANA_ACCESS_TOKEN: token } });
      expect(tls.exitCode).toBe(2);
      expect(JSON.parse(tls.stderr)).toMatchObject({ error: { code: "policy-denied" } });
      expect(tls.stderr).not.toContain(token);
    } finally { await removeFixture(fixture); }
  });
});
