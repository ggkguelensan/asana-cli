import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readCurrentGitStorageIdentity } from "../src/git-context";
import { runGitSync } from "./support/git";
import { TemporaryDirectories } from "./support/temp";

const temporaryDirectories = new TemporaryDirectories();

afterEach(async () => {
  await temporaryDirectories.cleanup();
});

describe("opaque Git storage identity", () => {
  test("shares a repository key across linked worktrees and isolates worktree keys", async () => {
    const root = await temporaryDirectories.create("asana-cli-git-storage-");
    const repository = join(root, "repository-private-path");
    const linked = join(root, "linked-private-path");
    await mkdir(repository);
    runGitSync(repository, ["init", "-b", "main"]);
    await writeFile(join(repository, "README.md"), "test\n");
    runGitSync(repository, ["add", "README.md"]);
    runGitSync(repository, [
      "-c", "user.name=Test",
      "-c", "user.email=test@example.com",
      "commit", "-m", "initial",
    ]);
    runGitSync(repository, ["worktree", "add", "-b", "linked", linked]);

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
