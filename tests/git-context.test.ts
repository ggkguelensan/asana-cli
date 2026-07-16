import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { runLocalAgentCommand } from "../src/agent-cli";
import { parseArgs } from "../src/args";
import { runCli } from "../src/cli";
import { CliError, normalizeError } from "../src/errors";
import { gitContextSchema } from "../src/git-context";
import { MemoryOperationRepository } from "../src/operations/memory-repository";
const directories: string[] = [];
const agentRuntime = { operations: new MemoryOperationRepository() };
const entrypoint = resolve(import.meta.dir, "../src/index.ts");

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

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asana-git-context-"));
  directories.push(directory);
  return directory;
}

async function git(directory: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn({
    cmd: ["/usr/bin/git", ...args],
    cwd: directory,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Git test fixture failed: ${args.join(" ")} (${stderr})`);
  }
  return stdout;
}

type RepositoryOptions = Readonly<{
  branch?: string;
  objectFormat?: "sha256";
  remote?: string;
}>;

async function repository(options: RepositoryOptions = {}): Promise<{ directory: string; commit: string }> {
  const directory = await temporaryDirectory();
  const initArgs = ["init", "--quiet", "--initial-branch", "main"];
  if (options.objectFormat !== undefined) initArgs.push(`--object-format=${options.objectFormat}`);
  await git(directory, initArgs);
  await writeFile(join(directory, "fixture.txt"), "git context fixture\n");
  await git(directory, ["add", "fixture.txt"]);
  await git(directory, [
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
    await git(directory, ["checkout", "--quiet", "-b", options.branch]);
  }
  await git(directory, ["remote", "add", "origin", options.remote ?? "https://github.example/Acme/widgets.git"]);
  return { directory, commit: (await git(directory, ["rev-parse", "--verify", "HEAD"])).trim() };
}

async function runEntrypoint(
  directory: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env = Object.fromEntries(Object.entries({
    ...process.env,
    ASANA_ACCESS_TOKEN: undefined,
    ASANA_PAT: undefined,
  }).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const child = Bun.spawn({
    cmd: [process.execPath, "run", "--no-env-file", entrypoint, ...args],
    cwd: directory,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
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
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
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
    const directory = await temporaryDirectory();
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
