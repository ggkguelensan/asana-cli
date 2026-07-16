import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { runLocalAgentCommand } from "../src/agent-cli";
import { parseArgs } from "../src/args";
import { CliError, normalizeError } from "../src/errors";
import { MemoryOperationRepository } from "../src/operations/memory-repository";
import {
  computeRepositoryContextDigest,
  FixedFileRepositoryContextManifestProvider,
  MAX_REPOSITORY_CONTEXT_BYTES,
  parseRepositoryContextJson,
  parseRepositoryContextManifest,
  projectRepositoryContext,
  repositoryContextDataSchema,
  repositoryContextManifestSchema,
} from "../src/repository-context";

const directories: string[] = [];
const entrypoint = resolve(import.meta.dir, "../src/index.ts");

function minimalManifest(): Record<string, unknown> {
  return {
    schema: "asana-cli.repository-context.v1",
    revision: 7,
    workspace_gid: "100",
    mappings: [{ kind: "project", alias: "platform", project_gid: "200" }],
  };
}

function fullManifest(): Record<string, unknown> {
  return {
    schema: "asana-cli.repository-context.v1",
    revision: 7,
    workspace_gid: "100",
    mappings: [
      { kind: "task", project_alias: "web", alias: "500--wire-up", task_gid: "500" },
      { kind: "custom-field", alias: "priority", custom_field_gid: "401" },
      { kind: "project", alias: "web", project_gid: "201" },
      { kind: "section", project_alias: "platform", alias: "inbox", section_gid: "300" },
      { kind: "project", alias: "platform", project_gid: "200" },
      { kind: "custom-field", alias: "build", custom_field_gid: "400" },
      {
        kind: "task",
        project_alias: "platform",
        alias: "dev-012--repository-context",
        task_gid: "500",
      },
    ],
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asana-repository-context-"));
  directories.push(directory);
  return directory;
}

async function git(directory: string, args: readonly string[]): Promise<void> {
  const child = Bun.spawn({
    cmd: ["/usr/bin/git", ...args],
    cwd: directory,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`Git test fixture failed: ${args.join(" ")} (${stderr})`);
}

async function repository(): Promise<string> {
  const directory = await temporaryDirectory();
  await git(directory, ["init", "--quiet", "--initial-branch", "main"]);
  return directory;
}

async function writeContext(directory: string, source: string | Uint8Array): Promise<string> {
  const contextDirectory = join(directory, ".asana-cli");
  await mkdir(contextDirectory);
  const path = join(contextDirectory, "repository-context.json");
  await writeFile(path, source);
  return path;
}

async function fromDirectory<Result>(directory: string, action: () => Promise<Result>): Promise<Result> {
  const previous = process.cwd();
  process.chdir(directory);
  try {
    return await action();
  } finally {
    process.chdir(previous);
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

async function runEntrypoint(
  directory: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const environment = Object.fromEntries(Object.entries({
    ...process.env,
    ASANA_ACCESS_TOKEN: undefined,
    ASANA_PAT: undefined,
  }).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const child = Bun.spawn({
    cmd: [process.execPath, "run", "--no-env-file", entrypoint, ...args],
    cwd: directory,
    env: environment,
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

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("repository context manifest", () => {
  test("accepts the minimal and complete v1 manifests, preserving task GIDs shared by distinct qualified aliases", () => {
    const minimal = parseRepositoryContextManifest(minimalManifest());
    const full = parseRepositoryContextManifest(fullManifest());

    expect(projectRepositoryContext(minimal)).toMatchObject({
      workspace_gid: "100",
      projects: [{ alias: "platform", project_gid: "200" }],
      sections: [],
      custom_fields: [],
      tasks: [],
    });
    expect(projectRepositoryContext(full)).toMatchObject({
      projects: [
        { alias: "platform", project_gid: "200" },
        { alias: "web", project_gid: "201" },
      ],
      sections: [{ project_alias: "platform", alias: "inbox", section_gid: "300" }],
      custom_fields: [
        { alias: "build", custom_field_gid: "400" },
        { alias: "priority", custom_field_gid: "401" },
      ],
      tasks: [
        {
          project_alias: "platform",
          alias: "dev-012--repository-context",
          qualified_alias: "task:platform/dev-012--repository-context",
          task_gid: "500",
        },
        {
          project_alias: "web",
          alias: "500--wire-up",
          qualified_alias: "task:web/500--wire-up",
          task_gid: "500",
        },
      ],
    });
  });

  test("rejects noncanonical aliases, schema bounds, unknown fields, dangling scopes, and every semantic duplicate dimension", () => {
    const project = { kind: "project", alias: "platform", project_gid: "200" };
    const section = { kind: "section", project_alias: "platform", alias: "inbox", section_gid: "300" };
    const customField = { kind: "custom-field", alias: "priority", custom_field_gid: "400" };
    const task = {
      kind: "task",
      project_alias: "platform",
      alias: "dev-012--repository-context",
      task_gid: "500",
    };
    const invalid: readonly unknown[] = [
      { ...minimalManifest(), schema: "asana-cli.repository-context.v2" },
      { ...minimalManifest(), revision: 0 },
      { ...minimalManifest(), revision: 1.5 },
      { ...minimalManifest(), revision: 2_147_483_648 },
      { ...minimalManifest(), workspace_gid: "workspace-canary" },
      { ...minimalManifest(), unexpected: true },
      { ...minimalManifest(), digest: `sha256:${"a".repeat(64)}` },
      { ...minimalManifest(), mappings: [] },
      { ...minimalManifest(), mappings: Array.from({ length: 101 }, () => project) },
      { ...minimalManifest(), mappings: [{ ...project, alias: "Platform" }] },
      { ...minimalManifest(), mappings: [{ ...project, alias: "plat form" }] },
      { ...minimalManifest(), mappings: [{ ...project, alias: "平台" }] },
      { ...minimalManifest(), mappings: [{ ...project, alias: "platform/other" }] },
      { ...minimalManifest(), mappings: [{ ...project, alias: "platform%20other" }] },
      { ...minimalManifest(), mappings: [{ ...project, extra: true }] },
      { ...minimalManifest(), mappings: [project, { ...section, extra: true }] },
      { ...minimalManifest(), mappings: [project, { ...customField, extra: true }] },
      { ...minimalManifest(), mappings: [project, { ...task, extra: true }] },
      { ...minimalManifest(), mappings: [project, { ...section, project_alias: "missing" }] },
      { ...minimalManifest(), mappings: [project, { ...section, section_gid: "not-a-gid" }] },
      { ...minimalManifest(), mappings: [project, { ...customField, custom_field_gid: "not-a-gid" }] },
      { ...minimalManifest(), mappings: [project, { ...task, task_gid: "not-a-gid" }] },
      { ...minimalManifest(), mappings: [project, { ...project, project_gid: "201" }] },
      { ...minimalManifest(), mappings: [project, { ...project, alias: "web" }] },
      { ...minimalManifest(), mappings: [project, section, { ...section, section_gid: "301" }] },
      { ...minimalManifest(), mappings: [project, section, { ...section, alias: "done" }] },
      { ...minimalManifest(), mappings: [project, customField, { ...customField, custom_field_gid: "401" }] },
      { ...minimalManifest(), mappings: [project, customField, { ...customField, alias: "build" }] },
      { ...minimalManifest(), mappings: [project, task, { ...task, task_gid: "501" }] },
      { ...minimalManifest(), mappings: [project, { ...task, project_alias: "missing" }] },
      { ...minimalManifest(), mappings: [project, { ...task, alias: "dev-012-repository-context" }] },
      { ...minimalManifest(), mappings: [project, { ...task, alias: "Dev-012--repository-context" }] },
      { ...minimalManifest(), mappings: [project, { ...task, alias: "dev-012--repository/context" }] },
      { ...minimalManifest(), mappings: [project, { ...task, alias: "dev-012--repository--context" }] },
    ];

    for (const value of invalid) {
      expect(repositoryContextManifestSchema.safeParse(value).success).toBe(false);
    }
  });

  test("rejects duplicate decoded JSON keys and prototype-pollution keys before schema validation", () => {
    const invalidJson = [
      '{"schema":"a","schema":"b"}',
      '{"schema":"a","sche\\u006da":"b"}',
      '{"mappings":[{"kind":"project","alias":"one","alias":"two"}]}',
      '{"\\u005f\\u005fproto\\u005f\\u005f":{}}',
      '{"constructor":{}}',
      '{"prototype":{}}',
      '{"mappings":[{"constructor":{}}]}',
      '{"nested":{"prototype":{}}}',
    ];

    for (const source of invalidJson) {
      expect(() => parseRepositoryContextJson(source)).toThrow("Invalid repository context JSON");
    }
  });

  test("uses semantic sorting for the digest and public projection while detecting every semantic change", () => {
    const first = parseRepositoryContextManifest(fullManifest());
    const reordered = parseRepositoryContextManifest({
      workspace_gid: "100",
      mappings: [...(fullManifest().mappings as unknown[])].reverse(),
      revision: 7,
      schema: "asana-cli.repository-context.v1",
    });
    const changedRevision = parseRepositoryContextManifest({ ...fullManifest(), revision: 8 });
    const changedTask = parseRepositoryContextManifest({
      ...fullManifest(),
      mappings: (fullManifest().mappings as Record<string, unknown>[]).map((mapping) =>
        mapping.kind === "task" && mapping.project_alias === "platform"
          ? { ...mapping, task_gid: "501" }
          : mapping),
    });

    expect(computeRepositoryContextDigest(first)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(computeRepositoryContextDigest(reordered)).toBe(computeRepositoryContextDigest(first));
    expect(projectRepositoryContext(reordered)).toEqual(projectRepositoryContext(first));
    expect(computeRepositoryContextDigest(changedRevision)).not.toBe(computeRepositoryContextDigest(first));
    expect(computeRepositoryContextDigest(changedTask)).not.toBe(computeRepositoryContextDigest(first));
  });
});

describe("fixed-root repository context provider", () => {
  test("discovers only the worktree-root manifest from a nested directory without an origin remote", async () => {
    const root = await repository();
    const nested = join(root, "nested", "worktree");
    await mkdir(nested, { recursive: true });
    const sourceCanary = "MANIFEST_SOURCE_PRIVATE_CANARY";
    await writeContext(root, JSON.stringify(fullManifest()));
    await mkdir(join(nested, ".asana-cli"));
    await writeFile(join(nested, ".asana-cli", "repository-context.json"), sourceCanary);

    const data = await fromDirectory(nested, () => new FixedFileRepositoryContextManifestProvider().load());
    expect(repositoryContextDataSchema.parse(data)).toMatchObject({
      workspace_gid: "100",
      tasks: expect.arrayContaining([expect.objectContaining({
        qualified_alias: "task:platform/dev-012--repository-context",
        task_gid: "500",
      })]),
    });
    expect(JSON.stringify(data)).not.toContain(root);
    expect(JSON.stringify(data)).not.toContain(sourceCanary);
  });

  test("does not fall back to parent, nested, alternate, or non-Git manifest locations", async () => {
    const root = await repository();
    const nested = join(root, "nested");
    await mkdir(nested);
    await mkdir(join(nested, ".asana-cli"));
    await writeFile(join(nested, ".asana-cli", "repository-context.json"), JSON.stringify(minimalManifest()));
    await writeFile(join(root, "repository-context.json"), JSON.stringify(minimalManifest()));
    await writeFile(join(root, ".repository-context.json"), JSON.stringify(minimalManifest()));

    const missing = await fromDirectory(nested, () => caughtCliError(
      () => new FixedFileRepositoryContextManifestProvider().load(),
    ));
    const nonGit = await fromDirectory(await temporaryDirectory(), () => caughtCliError(
      () => new FixedFileRepositoryContextManifestProvider().load(),
    ));
    expect(missing).toEqual(new CliError("not-found", "Repository context is unavailable"));
    expect(nonGit).toEqual(new CliError("not-found", "Repository context is unavailable"));
    expect(JSON.stringify(missing)).not.toContain(root);
    expect(JSON.stringify(nonGit)).not.toContain("not a git repository");
  });

  test("fails closed for unsafe, oversized, nonregular, and malformed fixed files without leaking source paths or contents", async () => {
    const canary = "REPOSITORY_CONTEXT_PRIVATE_CANARY";
    const cases: Array<{ name: string; arrange: (root: string) => Promise<void> }> = [
      {
        name: "invalid UTF-8",
        arrange: async (root) => { await writeContext(root, new Uint8Array([0xff, 0xfe])); },
      },
      {
        name: "malformed JSON",
        arrange: async (root) => { await writeContext(root, `{${canary}`); },
      },
      {
        name: "oversized JSON",
        arrange: async (root) => { await writeContext(root, "x".repeat(MAX_REPOSITORY_CONTEXT_BYTES + 1)); },
      },
      {
        name: "final symlink",
        arrange: async (root) => {
          const target = join(root, "target.json");
          await writeFile(target, JSON.stringify(minimalManifest()));
          await mkdir(join(root, ".asana-cli"));
          await symlink(target, join(root, ".asana-cli", "repository-context.json"));
        },
      },
      {
        name: "context directory symlink",
        arrange: async (root) => {
          const target = join(root, "target-context");
          await mkdir(target);
          await writeFile(join(target, "repository-context.json"), JSON.stringify(minimalManifest()));
          await symlink(target, join(root, ".asana-cli"));
        },
      },
      {
        name: "directory leaf",
        arrange: async (root) => {
          await mkdir(join(root, ".asana-cli"));
          await mkdir(join(root, ".asana-cli", "repository-context.json"));
        },
      },
      {
        name: "unreadable leaf",
        arrange: async (root) => {
          const path = await writeContext(root, JSON.stringify(minimalManifest()));
          await chmod(path, 0o000);
        },
      },
    ];

    for (const testCase of cases) {
      const root = await repository();
      await testCase.arrange(root);
      const error = await fromDirectory(root, () => caughtCliError(
        () => new FixedFileRepositoryContextManifestProvider().load(),
      ));
      expect(error).toEqual(new CliError("storage-invalid", "Repository context storage is invalid"));
      expect(JSON.stringify(error)).not.toContain(root);
      expect(JSON.stringify(error)).not.toContain(canary);
    }
  });
});

describe("agent context --repository-context", () => {
  test("is a no-PAT local read that emits only the deterministic public context envelope", async () => {
    const root = await repository();
    const nested = join(root, "nested");
    await mkdir(nested);
    const sourceCanary = "MANIFEST_SOURCE_PRIVATE_CANARY";
    await writeContext(root, JSON.stringify(fullManifest()));
    await writeFile(join(root, "repository-context.json"), sourceCanary);

    const invocation = await runEntrypoint(nested, ["agent", "context", "--repository-context"]);
    const envelope = z.looseObject({
      schema: z.literal("asana-cli.agent.v2"),
      result: z.looseObject({
        operation: z.literal("repository.context.current"),
        effect: z.literal("read"),
        data: repositoryContextDataSchema,
      }),
    }).parse(JSON.parse(invocation.stdout));

    expect(invocation.exitCode).toBe(0);
    expect(invocation.stderr).toBe("");
    expect(envelope.result.data.tasks).toContainEqual({
      project_alias: "platform",
      alias: "dev-012--repository-context",
      qualified_alias: "task:platform/dev-012--repository-context",
      task_gid: "500",
    });
    const serialized = `${invocation.stdout}${invocation.stderr}`;
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain("repository-context.json");
    expect(serialized).not.toContain(sourceCanary);
    expect(serialized).not.toContain("remote");
    expect(serialized).not.toContain("branch");
    expect(serialized).not.toContain("commit");
  });

  test("validates malformed repository-context selectors before provider, Git, file, or operation work", async () => {
    const operations = new MemoryOperationRepository();
    const malformed = [
      ["agent", "context", "--repository-context=value"],
      ["agent", "context", "--repository-context", "value"],
      ["agent", "context", "--repository-context", "--repository-context"],
      ["agent", "context", "--no-repository-context"],
      ["agent", "context", "--repository-context", "--input", "-"],
      ["agent", "context", "--repository-context", "--git-current-candidates", "--workspace", "100"],
    ];

    for (const argv of malformed) {
      const error = await caughtCliError(() => runLocalAgentCommand(parseArgs(argv), {
        operations,
        repositoryContext: { load: async () => { throw new Error("PROVIDER_MUST_NOT_RUN"); } },
      }));
      expect(error).toMatchObject({
        code: "usage",
        message: "Usage: asana-cli agent context --repository-context",
      });
      expect(JSON.stringify(error)).not.toContain("PROVIDER_MUST_NOT_RUN");
    }
  });

  test("does not turn a manifest task alias into an operation, candidate lookup, or write authorization", async () => {
    const root = await repository();
    await writeContext(root, JSON.stringify(fullManifest()));
    const operations = {
      create: (): never => { throw new Error("REPOSITORY_CONTEXT_MUST_NOT_CREATE_OPERATION"); },
      get: (): never => { throw new Error("REPOSITORY_CONTEXT_MUST_NOT_GET_OPERATION"); },
      inspect: (): never => { throw new Error("REPOSITORY_CONTEXT_MUST_NOT_INSPECT_OPERATION"); },
      compareAndSet: (): never => { throw new Error("REPOSITORY_CONTEXT_MUST_NOT_UPDATE_OPERATION"); },
    };
    const result = await fromDirectory(root, () => runLocalAgentCommand(
      parseArgs(["agent", "context", "--repository-context"]),
      { operations },
    ));

    const data = z.looseObject({ data: repositoryContextDataSchema }).parse(result).data;
    expect(data.tasks).toEqual(expect.arrayContaining([expect.objectContaining({
      qualified_alias: "task:platform/dev-012--repository-context",
      task_gid: "500",
    })]));
    expect(JSON.stringify(result)).not.toContain("candidate");
    expect(JSON.stringify(result)).not.toContain("selected");
    expect(JSON.stringify(result)).not.toContain("REPOSITORY_CONTEXT_MUST_NOT");
  });

});
