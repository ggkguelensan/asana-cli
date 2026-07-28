import { describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  appendInvocationLog,
  createInvocationLogEvent,
  INVOCATION_LOG_FILE,
  invocationLogEventSchema,
  probeInvocationLog,
} from "../src/invocation-log";

describe("local invocation log", () => {
  test("records bounded metadata without arguments, task content, or credentials", () => {
    const pat = "PAT_CANARY_SHOULD_NEVER_BE_LOGGED";
    const comment = "COMMENT_CANARY_SHOULD_NEVER_BE_LOGGED";
    const taskGid = "1200123456789";
    const event = createInvocationLogEvent({
      argv: ["task", "comment", taskGid, comment, "--token", pat],
      startedAt: new Date("2026-07-28T00:00:00.000Z"),
      completedAt: new Date("2026-07-28T00:00:01.000Z"),
      durationMs: 1_000,
      exitCode: 2,
      errorCode: "policy-denied",
      invocationId: "00000000-0000-4000-8000-000000000701",
    });

    expect(invocationLogEventSchema.parse(event)).toEqual(event);
    expect(event).toMatchObject({
      command: "task",
      action: "comment",
      effect: "remote-write",
      outcome: "error",
      exit_code: 2,
      error_code: "policy-denied",
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(pat);
    expect(serialized).not.toContain(comment);
    expect(serialized).not.toContain(taskGid);
  });

  test("appends owner-only JSONL records safely under the state root", async () => {
    const root = await mkdtemp(join(tmpdir(), "asana-cli-invocation-log-"));
    try {
      const environment = {
        HOME: root,
        XDG_STATE_HOME: join(root, "state"),
      };
      const probe = await probeInvocationLog(environment);
      expect(probe.path.endsWith(`/audit/${INVOCATION_LOG_FILE}`)).toBeTrue();

      await Promise.all(Array.from({ length: 8 }, (_, index) =>
        appendInvocationLog({
          argv: ["doctor", "--offline"],
          startedAt: new Date("2026-07-28T00:00:00.000Z"),
          completedAt: new Date("2026-07-28T00:00:00.010Z"),
          durationMs: 10,
          exitCode: 0,
          invocationId: `00000000-0000-4000-8000-${String(800 + index).padStart(12, "0")}`,
        }, environment)
      ));

      const lines = (await readFile(probe.path, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(8);
      expect(lines.map((line) => invocationLogEventSchema.parse(
        JSON.parse(line) as unknown,
      ).command)).toEqual(Array(8).fill("doctor"));
      expect((await lstat(probe.path)).mode & 0o777).toBe(0o600);
      expect((await lstat(dirname(probe.path))).mode & 0o777).toBe(0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a symlinked log target", async () => {
    const root = await mkdtemp(join(tmpdir(), "asana-cli-invocation-log-link-"));
    try {
      const state = join(root, "state");
      const environment = { HOME: root, XDG_STATE_HOME: state };
      const probe = await probeInvocationLog(environment);
      const target = join(root, "outside.log");
      await rm(probe.path);
      await Bun.write(target, "");
      await chmod(target, 0o600);
      await symlink(target, probe.path);

      expect(probeInvocationLog(environment)).rejects.toThrow("unsafe");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
