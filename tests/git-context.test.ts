import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { runLocalAgentCommand } from "../src/agent-cli";
import { parseArgs } from "../src/args";
import { runCli } from "../src/cli";
import { CliError, normalizeError } from "../src/errors";
import { gitContextSchema } from "../src/git-context";
import { MemoryOperationRepository } from "../src/operations/memory-repository";
import { runGit } from "./support/git";
import { runSourceCli } from "./support/process";
import { TemporaryDirectories } from "./support/temp";

const directories = new TemporaryDirectories();
const agentRuntime = { operations: new MemoryOperationRepository() };

const gitContextResultSchema = z.looseObject({
  operation: z.literal("git.context.current"),
  effect: z.literal("read"),
  policy: z.literal("read"),
  data: gitContextSchema,
});

const agentSuccessSchema = z.looseObject({
  schema: z.literal("asana-cli.agent.v2"),
  result: gitContextResultSchema,
});

const agentErrorSchema = z.looseObject({
  schema: z.literal("asana-cli.agent.v2"),
  result: z.looseObject({
    error: z.strictObject({
      code: z.string(),
      message: z.string(),
      exit_code: z.number().int(),
    }),
  }),
});

type RepositoryOptions = Readonly<{
  branch?: string;
  objectFormat?: "sha256";
  remote?: string;
}>;

async function repository(options: RepositoryOptions = {}): Promise<{ directory: string; commit: string }> {
  const directory = await directories.create("asana-git-context-");
  const initArgs = ["init", "--quiet", "--initial-branch", "main"];
  if (options.objectFormat !== undefined) initArgs.push(`--object-format=${options.objectFormat}`);
  await runGit(directory, initArgs);
  await writeFile(join(directory, "fixture.txt"), "git context fixture\n");
  await runGit(directory, ["add", "fixture.txt"]);
  await runGit(directory, [
    "-c",
    "user.name=Git Context Test",
    "-c",
    "user.email=git-context-test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  if (options.branch !== undefined) {
    await runGit(directory, ["checkout", "--quiet", "-b", options.branch]);
  }
  await runGit(directory, [
    "remote",
    "add",
    "origin",
    options.remote ?? "https://github.example/Acme/widgets.git",
  ]);
  return {
    directory,
    commit: await runGit(directory, ["rev-parse", "--verify", "HEAD"]),
  };
}

async function runEntrypoint(
  directory: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return runSourceCli(args, {
    cwd: directory,
    env: {
      ASANA_ACCESS_TOKEN: undefined,
      ASANA_PAT: undefined,
    },
  });
}

async function caughtCliError(action: () => Promise<unknown>): Promise<CliError> {
  try {
    await action();
  } catch (error) {
    return normalizeError(error);
  }
  throw new Error("Expected action to fail");
}

afterEach(async () => {
  await directories.cleanup();
});

describe("agent context --git-current", () => {
  test("returns only normalized repository identity, branch, commit, and deduplicated work-item tokens", async () => {
    const fixture = await repository({ branch: "feature/pr-42_issue_7" });

    const invocation = await runEntrypoint(fixture.directory, ["agent", "context", "--git-current"]);
    const result = agentSuccessSchema.parse(JSON.parse(invocation.stdout)).result;

    expect(invocation.exitCode).toBe(0);
    expect(invocation.stderr).toBe("");
    expect(result).toEqual({
      operation: "git.context.current",
      effect: "read",
      policy: "read",
      data: {
        remote: { host: "github.example" },
        repository: { owner: "Acme", name: "widgets" },
        branch: "feature/pr-42_issue_7",
        commit: fixture.commit,
        tokens: [
          { kind: "pull-request", number: 42 },
          { kind: "issue", number: 7 },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain("https://github.example/Acme/widgets.git");
    expect(JSON.stringify(result)).not.toContain(fixture.directory);
  });

  test("rejects remote forms outside the public grammar without leaking remote text", async () => {
    const remotes = [
      "https://REMOTE_CREDENTIAL_CANARY@git.example/Acme/widgets.git",
      "file:///LOCAL_PATH_CANARY/Acme/widgets.git",
    ];

    for (const remote of remotes) {
      const fixture = await repository({ remote });
      const invocation = await runEntrypoint(fixture.directory, ["agent", "context", "--git-current"]);
      const error = agentErrorSchema.parse(JSON.parse(invocation.stderr)).result.error;

      expect(invocation.exitCode).toBe(2);
      expect(invocation.stdout).toBe("");
      expect(error).toEqual({
        code: "validation",
        message: "Git context contains unsupported or invalid data",
        exit_code: 2,
      });
      expect(`${invocation.stdout}${invocation.stderr}`).not.toContain(remote);
      expect(`${invocation.stdout}${invocation.stderr}`).not.toContain("REMOTE_CREDENTIAL_CANARY");
      expect(`${invocation.stdout}${invocation.stderr}`).not.toContain("LOCAL_PATH_CANARY");
    }
  });

  test("rejects supported Git state that falls outside the bounded branch and commit contract", async () => {
    const branchFixture = await repository({ branch: "feature+BRANCH_CANARY" });
    const sha256Fixture = await repository({ objectFormat: "sha256" });

    for (const fixture of [branchFixture, sha256Fixture]) {
      const invocation = await runEntrypoint(fixture.directory, ["agent", "context", "--git-current"]);
      const error = agentErrorSchema.parse(JSON.parse(invocation.stderr)).result.error;

      expect(invocation.exitCode).toBe(2);
      expect(invocation.stdout).toBe("");
      expect(error).toEqual({
        code: "validation",
        message: "Git context contains unsupported or invalid data",
        exit_code: 2,
      });
      expect(`${invocation.stdout}${invocation.stderr}`).not.toContain("feature+BRANCH_CANARY");
      expect(`${invocation.stdout}${invocation.stderr}`).not.toContain(sha256Fixture.commit);
    }
  });

  test("maps a non-Git worktree to the local not-found contract without diagnostic leakage", async () => {
    const directory = await directories.create("asana-git-context-");
    const invocation = await runEntrypoint(directory, ["agent", "context", "--git-current"]);
    const error = agentErrorSchema.parse(JSON.parse(invocation.stderr)).result.error;

    expect(invocation.exitCode).toBe(4);
    expect(invocation.stdout).toBe("");
    expect(error).toEqual({
      code: "not-found",
      message: "Git context is unavailable from the current worktree",
      exit_code: 4,
    });
    expect(`${invocation.stdout}${invocation.stderr}`).not.toContain(directory);
    expect(`${invocation.stdout}${invocation.stderr}`).not.toContain("not a git repository");
  });

  test("rejects input and variations of the single required flag", async () => {
    const malformedInvocations = [
      ["agent", "context"],
      ["agent", "context", "unexpected", "--git-current"],
      ["agent", "context", "--git-current", "extra"],
      ["agent", "context", "--git-current", "--unexpected"],
      ["agent", "context", "--git-current", "--git-current"],
      ["agent", "context", "--git-current=value"],
      ["agent", "context", "--no-git-current"],
      ["agent", "context", "--git-current", "value"],
      ["agent", "context", "--input", "-"],
    ];

    for (const argv of malformedInvocations) {
      const error = await caughtCliError(() => runLocalAgentCommand(parseArgs(argv), agentRuntime));
      expect(error).toMatchObject({
        code: "usage",
        message: "Usage: asana-cli agent context --git-current",
      });
    }
  });
});
