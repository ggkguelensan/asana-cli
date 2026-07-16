import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runLocalAgentCommand } from "../src/agent-cli";
import { parseArgs } from "../src/args";
import { runCli } from "../src/cli";
import { CliError, normalizeError } from "../src/errors";
import { MemoryOperationRepository } from "../src/operations/memory-repository";
import {
  FixedFileRepositoryAsanaMappingProvider,
  fixedRepositoryAsanaMappingPath,
  parseRepositoryAsanaMappingFile,
  type RepositoryAsanaMapping,
  type RepositoryAsanaMappingFile,
  type WindowsRepositoryAsanaMappingCommandResult,
} from "../src/repository-asana-mapping";

const textEncoder = new TextEncoder();
const directories: string[] = [];
const operations = new MemoryOperationRepository();

const matchingIdentity = {
  remote: { host: "github.example" },
  repository: { owner: "Acme", name: "widgets" },
};

const mapping: RepositoryAsanaMapping = {
  ...matchingIdentity,
  workspace_gid: "1200",
  project_gid: "2200",
  git_reference_custom_field_gid: "3200",
};

const minimalMapping: RepositoryAsanaMapping = {
  ...matchingIdentity,
  workspace_gid: "1200",
};

function mappingFile(
  mappings: readonly RepositoryAsanaMapping[] = [mapping],
): RepositoryAsanaMappingFile {
  return {
    schema: "asana-cli.repository-asana-mapping.v1",
    mappings: [...mappings],
  };
}

function windowsResult(
  stdout: string,
  options: Readonly<Partial<Pick<WindowsRepositoryAsanaMappingCommandResult, "stderr" | "exitCode">>> = {},
): WindowsRepositoryAsanaMappingCommandResult {
  return {
    stdout: textEncoder.encode(stdout),
    stderr: options.stderr ?? new Uint8Array(),
    exitCode: options.exitCode ?? 0,
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asana-repository-asana-mapping-"));
  directories.push(directory);
  return directory;
}

async function git(directory: string, args: readonly string[]): Promise<void> {
  const child = Bun.spawn({ cmd: ["git", ...args], cwd: directory, stdout: "pipe", stderr: "pipe" });
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`Git fixture failed: ${args.join(" ")} (${stderr})`);
}

async function repository(): Promise<string> {
  const directory = await temporaryDirectory();
  await git(directory, ["init", "-q"]);
  await git(directory, ["config", "user.email", "test@example.invalid"]);
  await git(directory, ["config", "user.name", "Test User"]);
  await git(directory, ["remote", "add", "origin", "git@github.example:Acme/widgets.git"]);
  await writeFile(join(directory, "README"), "fixture\n");
  await git(directory, ["add", "README"]);
  await git(directory, ["commit", "-qm", "fixture"]);
  return directory;
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

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("trusted repository-to-Asana mapping", () => {
  test("accepts the bounded v1 shape and rejects unsafe schema, identity, uniqueness, and size changes", () => {
    const anotherMinimalMapping: RepositoryAsanaMapping = {
      remote: { host: "gitlab.example" },
      repository: { owner: "Acme", name: "widgets" },
      workspace_gid: "1201",
    };
    expect(parseRepositoryAsanaMappingFile(mappingFile([mapping, anotherMinimalMapping]))).toEqual(mappingFile([
      mapping,
      anotherMinimalMapping,
    ]));

    const invalidFiles: readonly unknown[] = [
      { ...mappingFile(), schema: "asana-cli.repository-asana-mapping.v2" },
      { ...mappingFile(), unexpected: true },
      {
        ...mappingFile(),
        mappings: [{ ...mapping, remote: { host: "GitHub.example" } }],
      },
      {
        ...mappingFile(),
        mappings: [{ ...mapping, workspace_gid: "workspace-canary" }],
      },
      {
        ...mappingFile(),
        mappings: [{ ...mapping, repository: { ...mapping.repository, unexpected: true } }],
      },
      { ...mappingFile(), mappings: [] },
      { ...mappingFile(), mappings: Array.from({ length: 101 }, () => mapping) },
      { ...mappingFile(), mappings: [mapping, { ...mapping, workspace_gid: "1201" }] },
    ];

    for (const invalid of invalidFiles) {
      expect(() => parseRepositoryAsanaMappingFile(invalid)).toThrow(
        "Invalid repository-to-Asana mapping",
      );
    }
  });

  test("uses only the exact normalized host, owner, and repository name as the lookup key", async () => {
    const otherMapping: RepositoryAsanaMapping = {
      remote: { host: "github.example" },
      repository: { owner: "Acme", name: "widgets-api" },
      workspace_gid: "1201",
    };
    const encoded = Buffer.from(JSON.stringify(mappingFile([mapping, otherMapping]))).toString("base64");
    const provider = new FixedFileRepositoryAsanaMappingProvider({
      platform: "win32",
      windowsCommandRunner: async () => windowsResult(encoded),
    });

    await expect(provider.find(matchingIdentity)).resolves.toEqual(mapping);
    for (const identity of [
      { remote: { host: "github.example" }, repository: { owner: "acme", name: "widgets" } },
      { remote: { host: "github.example" }, repository: { owner: "Acme", name: "widget" } },
      { remote: { host: "github.example" }, repository: { owner: "Acme", name: "widgets-api-v2" } },
      { remote: { host: "git.example" }, repository: { owner: "Acme", name: "widgets" } },
    ]) {
      await expect(provider.find(identity)).resolves.toBeUndefined();
    }
  });

  test("uses the fixed platform locations and rejects developer-controlled POSIX replacements without disclosure", async () => {
    expect(fixedRepositoryAsanaMappingPath("darwin")).toBe(
      "/private/etc/asana-cli/repository-asana-mapping.json",
    );
    expect(fixedRepositoryAsanaMappingPath("linux")).toBe(
      "/etc/asana-cli/repository-asana-mapping.json",
    );
    expect(fixedRepositoryAsanaMappingPath("win32")).toBe(
      "C:\\ProgramData\\asana-cli\\repository-asana-mapping.json",
    );

    const directory = await temporaryDirectory();
    const malformedPath = join(directory, "MAPPING_PATH_CANARY.json");
    const writablePath = join(directory, "writable.json");
    const linkPath = join(directory, "mapping-link.json");
    const contentCanary = "MAPPING_CONTENT_CANARY:not-json";
    await writeFile(malformedPath, contentCanary, { mode: 0o600 });
    await writeFile(writablePath, JSON.stringify(mappingFile()), { mode: 0o600 });
    await chmod(writablePath, 0o666);
    await symlink(malformedPath, linkPath);

    for (const path of [malformedPath, writablePath, linkPath]) {
      const error = await caughtCliError(() => new FixedFileRepositoryAsanaMappingProvider({
        platform: "darwin",
        path,
      }).find(matchingIdentity));
      expect(error).toEqual(new CliError(
        "storage-invalid",
        "Trusted repository-to-Asana mapping is unavailable",
      ));
      expect(JSON.stringify(error)).not.toContain(path);
      expect(JSON.stringify(error)).not.toContain(contentCanary);
    }
  });

  test("uses one frozen fixed-path Windows inspector command and fails closed on untrusted payloads", async () => {
    const callerPath = "C:\\untrusted\\MAPPING_PATH_CANARY.json";
    const encoded = Buffer.from(JSON.stringify(mappingFile())).toString("base64");
    let command: readonly string[] | undefined;
    const provider = new FixedFileRepositoryAsanaMappingProvider({
      platform: "win32",
      path: callerPath,
      windowsCommandRunner: async (receivedCommand) => {
        command = receivedCommand;
        return windowsResult(encoded);
      },
    });

    await expect(provider.find(matchingIdentity)).resolves.toEqual(mapping);
    expect(provider.path).toBe("C:\\ProgramData\\asana-cli\\repository-asana-mapping.json");
    expect(command).toBeDefined();
    expect(Object.isFrozen(command)).toBe(true);
    expect(command?.slice(0, 5)).toEqual([
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
    ]);
    expect(command?.[5]).toContain("$mappingPath = 'C:\\ProgramData\\asana-cli\\repository-asana-mapping.json'");
    expect(command?.join("\n")).not.toContain(callerPath);

    const malformedResults: readonly WindowsRepositoryAsanaMappingCommandResult[] = [
      windowsResult(encoded, { exitCode: 1 }),
      windowsResult(encoded, { stderr: textEncoder.encode("MAPPING_STDERR_CANARY") }),
      windowsResult("not-base64!"),
      windowsResult(Buffer.from("{}").toString("base64").replace(/=$/, "")),
      windowsResult(Buffer.from("MAPPING_CONTENT_CANARY:not-json").toString("base64")),
      windowsResult(Buffer.from(`${" ".repeat(49_153)}${JSON.stringify(mappingFile())}`).toString("base64")),
    ];
    for (const result of malformedResults) {
      const error = await caughtCliError(() => new FixedFileRepositoryAsanaMappingProvider({
        platform: "win32",
        windowsCommandRunner: async () => result,
      }).find(matchingIdentity));
      expect(error).toEqual(new CliError(
        "storage-invalid",
        "Trusted repository-to-Asana mapping is unavailable",
      ));
      expect(JSON.stringify(error)).not.toContain("MAPPING_STDERR_CANARY");
      expect(JSON.stringify(error)).not.toContain("MAPPING_CONTENT_CANARY");
    }
  });
});

describe("agent context --repository-asana", () => {
  test("projects one matching mapping with normalized Git identity only through the local no-PAT action", async () => {
    const directory = await repository();
    const result = await fromDirectory(directory, () => runLocalAgentCommand(
      parseArgs(["agent", "context", "--repository-asana"]),
      {
        operations,
        repositoryAsanaMapping: { find: async () => mapping },
      },
    ));
    const data = z.strictObject({
      git: z.strictObject({
        remote: z.strictObject({ host: z.literal("github.example") }),
        repository: z.strictObject({ owner: z.literal("Acme"), name: z.literal("widgets") }),
      }),
      mapping: z.strictObject({
        workspace_gid: z.literal("1200"),
        project_gid: z.literal("2200"),
        git_reference_custom_field_gid: z.literal("3200"),
      }),
    }).parse(z.looseObject({ data: z.unknown() }).parse(result).data);

    expect(data).toEqual({
      git: matchingIdentity,
      mapping: {
        workspace_gid: "1200",
        project_gid: "2200",
        git_reference_custom_field_gid: "3200",
      },
    });
    expect(JSON.stringify(data)).not.toContain("git@github.example");
    expect(JSON.stringify(data)).not.toContain(directory);
  });

  test("keeps local routing independent of PAT resolution and returns generic not-found results", async () => {
    const directory = await temporaryDirectory();
    const routingError = await fromDirectory(directory, () => caughtCliError(
      () => runCli(["agent", "context", "--repository-asana"]),
    ));
    expect(routingError).toEqual(new CliError(
      "not-found",
      "Git context is unavailable from the current worktree",
    ));

    const repositoryDirectory = await repository();
    const mappingError = await fromDirectory(repositoryDirectory, () => caughtCliError(
      () => runLocalAgentCommand(parseArgs(["agent", "context", "--repository-asana"]), {
        operations,
        repositoryAsanaMapping: { find: async () => undefined },
      }),
    ));
    expect(mappingError).toEqual(new CliError(
      "not-found",
      "No trusted repository-to-Asana mapping is configured for this repository",
    ));
    expect(JSON.stringify(mappingError)).not.toContain("github.example");
    expect(JSON.stringify(mappingError)).not.toContain("Acme");
  });
});
