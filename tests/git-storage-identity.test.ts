import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCurrentGitStorageIdentity } from "../src/git-context";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asana-cli-git-storage-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

function git(cwd: string, args: readonly string[]): void {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      LC_ALL: "C",
      LANG: "C",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

describe("opaque Git storage identity", () => {
  test("shares a repository key across linked worktrees and isolates worktree keys", async () => {
    const root = await temporaryDirectory();
    const repository = join(root, "repository-private-path");
    const linked = join(root, "linked-private-path");
    await mkdir(repository);
    git(repository, ["init", "-b", "main"]);
    await writeFile(join(repository, "README.md"), "test\n");
    git(repository, ["add", "README.md"]);
    git(repository, [
      "-c", "user.name=Test",
      "-c", "user.email=test@example.com",
      "commit", "-m", "initial",
    ]);
    git(repository, ["worktree", "add", "-b", "linked", linked]);

    const primary = await readCurrentGitStorageIdentity(repository);
    const secondary = await readCurrentGitStorageIdentity(linked);
    expect(primary.repository_key).toBe(secondary.repository_key);
    expect(primary.worktree_key).not.toBe(secondary.worktree_key);
    expect(primary.repository_key).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(primary.worktree_key).toMatch(/^sha256:[0-9a-f]{64}$/);

    const serialized = JSON.stringify({ primary, secondary });
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain("repository-private-path");
    expect(serialized).not.toContain("linked-private-path");
    expect(serialized).not.toContain("main");
    expect(serialized).not.toContain("linked");
  });
});
