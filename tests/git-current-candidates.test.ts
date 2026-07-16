import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runAgentCommand, runLocalAgentCommand } from "../src/agent-cli";
import { parseArgs } from "../src/args";
import { findGitCurrentCandidates } from "../src/git-current-candidates";
import type { GitContext } from "../src/git-context";
import { MemoryOperationRepository } from "../src/operations/memory-repository";
import { createClient } from "../src/sdk";

const directories: string[] = [];
const agentRuntime = { operations: new MemoryOperationRepository() };

const candidateResultSchema = z.strictObject({
  operation: z.literal("git.context.current.candidates"),
  effect: z.literal("read"),
  policy: z.literal("read"),
  data: z.strictObject({
    candidates: z.array(z.strictObject({
      task: z.strictObject({
        gid: z.string(),
        name: z.string().optional(),
      }),
      matches: z.array(z.looseObject({
        kind: z.string(),
        number: z.number().optional(),
        fields: z.array(z.string()),
      })),
    })),
    meta: z.strictObject({
      workspace_gid: z.string(),
      mine: z.boolean(),
      completed: z.boolean().optional(),
      count: z.number().int(),
      max_candidates: z.literal(20),
      truncated: z.boolean(),
      truncation_reasons: z.array(z.string()),
    }),
  }),
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asana-git-current-candidates-"));
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
  if (exitCode !== 0) throw new Error(`Git fixture failed: ${args.join(" ")} (${stderr})`);
  return stdout;
}

async function repository(branch: string): Promise<{ directory: string; commit: string }> {
  const directory = await temporaryDirectory();
  await git(directory, ["init", "--quiet", "--initial-branch", "main"]);
  await writeFile(join(directory, "fixture.txt"), "candidate lookup fixture\n");
  await git(directory, ["add", "fixture.txt"]);
  await git(directory, [
    "-c",
    "user.name=Candidate Test",
    "-c",
    "user.email=candidate-test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  await git(directory, ["checkout", "--quiet", "-b", branch]);
  await git(directory, ["remote", "add", "origin", "https://github.example/Acme/widgets.git"]);
  return { directory, commit: (await git(directory, ["rev-parse", "--verify", "HEAD"])).trim() };
}

async function fromDirectory<Result>(directory: string, action: () => Promise<Result>): Promise<Result> {
  const original = process.cwd();
  process.chdir(directory);
  try {
    return await action();
  } finally {
    process.chdir(original);
  }
}

function context(tokens: GitContext["tokens"] = []): GitContext {
  return {
    remote: { host: "github.example" },
    repository: { owner: "Acme", name: "widgets" },
    branch: "feature/PR-42_issue-7",
    commit: "a".repeat(40),
    tokens,
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("agent context --git-current-candidates", () => {
  test("routes authenticated current-Git lookup outside the local path and returns ordered exact evidence without content leakage", async () => {
    const branch = "feature/PR-42_issue-7-BRANCH_PRIVATE_CANARY";
    const fixture = await repository(branch);
    const requests: URL[] = [];
    const candidate = {
      gid: "20",
      name: "Acme/widgets delivery",
      notes: `${branch} ${fixture.commit} PR-42 issue-7 NOTES_PRIVATE_CANARY`,
      custom_fields: [{
        gid: "900",
        display_value: "PR-42 issue-7 CUSTOM_FIELD_PRIVATE_CANARY",
      }],
    };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requests.push(url);
        const lookup = url.searchParams.get("text")
          ?? url.searchParams.get("custom_fields.900.value");
        const data = lookup === "Acme/widgets"
          ? [candidate, { gid: "9", name: "Acme/widgetsX false positive" }]
          : lookup === "42"
          ? [candidate, { gid: "8", name: "PR-420 false positive" }]
          : lookup === "7"
          ? [
            candidate,
            { gid: "3", name: "Issue-7 standalone" },
            { gid: "4", name: "Issue-70 false positive" },
          ]
          : [candidate];
        return Response.json({ data, next_page: null });
      },
    });
    try {
      const client = createClient("CURRENT_GIT_CANDIDATE_TEST_TOKEN");
      client.basePath = new URL("/api/1.0", server.url).toString().replace(/\/$/, "");
      const args = parseArgs([
        "agent",
        "context",
        "--git-current-candidates",
        "--workspace",
        "1200",
        "--all-assignees",
        "--completed",
        "--field",
        "900",
      ]);

      await expect(runLocalAgentCommand(args, agentRuntime)).rejects.toThrow(
        "Usage: asana-cli agent context --git-current",
      );
      const result = candidateResultSchema.parse(await fromDirectory(
        fixture.directory,
        () => runAgentCommand(client, args, agentRuntime),
      ));

      expect(result.data).toEqual({
        candidates: [
          {
            task: { gid: "3", name: "Issue-7 standalone" },
            matches: [{ kind: "issue", number: 7, fields: ["name"] }],
          },
          {
            task: { gid: "20", name: "Acme/widgets delivery" },
            matches: [
              { kind: "repository", fields: ["name"] },
              { kind: "branch", fields: ["notes"] },
              { kind: "commit", fields: ["notes"] },
              { kind: "pull-request", number: 42, fields: ["notes", "custom-field"] },
              { kind: "issue", number: 7, fields: ["notes", "custom-field"] },
            ],
          },
        ],
        meta: {
          workspace_gid: "1200",
          mine: false,
          completed: true,
          count: 2,
          max_candidates: 20,
          truncated: false,
          truncation_reasons: [],
        },
      });
      expect(Object.keys(result.data)).toEqual(["candidates", "meta"]);
      for (const entry of result.data.candidates) {
        expect(Object.keys(entry)).toEqual(["task", "matches"]);
        expect(Object.keys(entry.task)).toEqual(["gid", "name"]);
      }
      const serialized = JSON.stringify(result.data);
      for (const canary of [
        "NOTES_PRIVATE_CANARY",
        "CUSTOM_FIELD_PRIVATE_CANARY",
        "BRANCH_PRIVATE_CANARY",
        fixture.commit,
        "https://github.example/Acme/widgets.git",
        fixture.directory,
      ]) {
        expect(serialized).not.toContain(canary);
      }

      expect(requests).toHaveLength(10);
      const expectedLookups = ["Acme/widgets", branch, fixture.commit, "42", "7"].sort();
      expect(requests.map((url) => url.searchParams.get("text")).filter(Boolean).sort()).toEqual(expectedLookups);
      expect(requests.map((url) => url.searchParams.get("custom_fields.900.value")).filter(Boolean).sort())
        .toEqual(expectedLookups);
      for (const request of requests) {
        expect(request.pathname).toBe("/api/1.0/workspaces/1200/tasks/search");
        expect(request.searchParams.get("limit")).toBe("21");
        expect(request.searchParams.get("completed")).toBe("true");
        expect(request.searchParams.has("assignee.any")).toBe(false);
        expect(request.searchParams.has("contains")).toBe(false);
        const fields = request.searchParams.get("opt_fields") ?? "";
        expect(fields).toContain("notes");
        expect(fields).toContain("custom_fields.gid");
        expect(fields).toContain("custom_fields.display_value");
        expect(fields).toContain("custom_fields.text_value");
      }
    } finally {
      server.stop(true);
    }
  });

  test("returns empty and singleton candidate sets without selecting or resolving either", async () => {
    let mode: "empty" | "singleton" = "empty";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json({
          data: mode === "empty" ? [] : [{ gid: "5", name: "Acme/widgets task" }],
          next_page: null,
        });
      },
    });
    try {
      const client = createClient("CANDIDATE_SELECTION_TEST_TOKEN");
      client.basePath = new URL("/api/1.0", server.url).toString().replace(/\/$/, "");
      const input = { workspace_gid: "1200", all_assignees: true, completed: false };
      const empty = await findGitCurrentCandidates(client, input, context());
      mode = "singleton";
      const singleton = await findGitCurrentCandidates(client, input, context());

      expect(empty).toEqual({
        candidates: [],
        meta: {
          workspace_gid: "1200",
          mine: false,
          completed: false,
          count: 0,
          max_candidates: 20,
          truncated: false,
          truncation_reasons: [],
        },
      });
      expect(singleton).toEqual({
        candidates: [{
          task: { gid: "5", name: "Acme/widgets task" },
          matches: [{ kind: "repository", fields: ["name"] }],
        }],
        meta: {
          workspace_gid: "1200",
          mine: false,
          completed: false,
          count: 1,
          max_candidates: 20,
          truncated: false,
          truncation_reasons: [],
        },
      });
      for (const result of [empty, singleton]) {
        expect(Object.keys(result)).toEqual(["candidates", "meta"]);
      }
    } finally {
      server.stop(true);
    }
  });

  test("caps candidates and reports every incompleteness reason without selecting from a truncated set", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json({
          data: Array.from({ length: 21 }, (_, index) => ({
            gid: String(21 - index),
            name: "Acme/widgets task",
          })),
          next_page: null,
        });
      },
    });
    try {
      const client = createClient("CANDIDATE_TRUNCATION_TEST_TOKEN");
      client.basePath = new URL("/api/1.0", server.url).toString().replace(/\/$/, "");
      const saturatedTokens = Array.from({ length: 16 }, (_, index) => ({
        kind: index % 2 === 0 ? "pull-request" as const : "issue" as const,
        number: index + 1,
      }));
      const result = await findGitCurrentCandidates(client, {
        workspace_gid: "1200",
        all_assignees: true,
      }, context(saturatedTokens));

      expect(result.candidates.map((candidate) => candidate.task.gid)).toEqual(
        Array.from({ length: 20 }, (_, index) => String(index + 1)),
      );
      expect(result.meta).toEqual({
        workspace_gid: "1200",
        mine: false,
        count: 20,
        max_candidates: 20,
        truncated: true,
        truncation_reasons: ["candidate-limit", "source-has-more", "git-token-limit"],
      });
      expect(Object.keys(result)).toEqual(["candidates", "meta"]);
    } finally {
      server.stop(true);
    }
  });
});
