import { asanaFixture } from "./support/asana-fixture";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { runAgentCommand } from "../apps/cli/src/agent-cli";
import { AGENT_MANIFEST } from "../apps/cli/src/agent-mode";
import { parseArgs } from "../apps/cli/src/args";
import { runCli } from "../apps/cli/src/cli";
import { CliError, normalizeError } from "../apps/cli/src/errors";
import { MemoryOperationRepository } from "../apps/cli/src/operations/memory-repository";
import type { AsanaClient } from "../apps/cli/src/sdk";

async function withAgentStdin<Result>(input: unknown, action: () => Promise<Result>): Promise<Result> {
  const runtime = Bun as unknown as { stdin: { text(): Promise<string> } };
  const original = runtime.stdin;
  runtime.stdin = { text: async () => JSON.stringify(input) };
  try {
    return await action();
  } finally {
    runtime.stdin = original;
  }
}

async function caughtCliError(action: () => Promise<unknown>): Promise<CliError> {
  try {
    await action();
  } catch (error) {
    return normalizeError(error);
  }
  throw new Error("Expected action to fail");
}

function v02CompatibleClient(): AsanaClient {
  const { client, sdk } = asanaFixture();
  Object.defineProperty(sdk, "callApi", {
    configurable: true,
    value: async () => ({
      response: {},
      data: {
        data: {
          gid: "123",
          name: "Legacy readable task",
          notes: "v0.2 stdin read payload",
          parent: {
            gid: "456",
            name: "Legacy parent task",
          },
        }
      },
    }),
  });
  return client;
}

describe("agent v0.2 compatibility", () => {
  test("keeps the legacy get-task stdin read envelope compatible", async () => {
    const result = z.looseObject({
      operation: z.literal("task.get"),
      data: z.strictObject({
        task: z.strictObject({
          gid: z.literal("123"),
          name: z.literal("Legacy readable task"),
          notes: z.literal("v0.2 stdin read payload"),
          parent: z.strictObject({
            gid: z.literal("456"),
            name: z.literal("Legacy parent task"),
          }),
        }),
        content_profile: z.literal("full-untrusted"),
        content_budget: z.looseObject({}),
      }),
    }).parse(await withAgentStdin({
      task_gid: "123",
      include_content: true,
      max_content_bytes: 256,
    }, () => runAgentCommand(
      v02CompatibleClient(),
      parseArgs(["agent", "get-task", "--input", "-"]),
      { operations: new MemoryOperationRepository() },
    )));

    expect(result.data.task).toEqual({
      gid: "123",
      name: "Legacy readable task",
      notes: "v0.2 stdin read payload",
      parent: {
        gid: "456",
        name: "Legacy parent task",
      },
    });
  });

  test("publishes the same canonical deprecated apply migration that rejection returns", async () => {
    const manifest = z.looseObject({
      deprecated_commands: z.record(z.string(), z.unknown()),
    }).parse(AGENT_MANIFEST);

    for (const action of ["apply-task-update", "apply-comment"] as const) {
      const error = await caughtCliError(() => runCli(["agent", action, "--input", "-"]));
      expect(error.code).toBe("usage");
      expect(JSON.stringify(error.details)).toBe(JSON.stringify(
        manifest.deprecated_commands[`asana-cli agent ${action}`],
      ));
    }
  });
});
