import { describe, expect, test } from "bun:test";
import {
  parseReleaseMetadata,
  verifyReleaseCommit,
  type GitExecutor,
} from "../scripts/release-preflight";

const commit = "a".repeat(40);

describe("release preflight", () => {
  test("requires the release tag to exactly match the package version", () => {
    expect(() => parseReleaseMetadata(
      { GITHUB_REF_NAME: "v0.2.1", GITHUB_SHA: commit },
      { version: "0.2.0" },
    )).toThrow("must exactly match package version v0.2.0");
  });

  test("accepts a tag whose commit belongs to origin/main", () => {
    const calls: string[][] = [];
    const runGit: GitExecutor = (args) => {
      calls.push([...args]);
      if (args[0] === "merge-base") return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: commit, stderr: "" };
    };
    const metadata = parseReleaseMetadata(
      { GITHUB_REF_NAME: "v0.2.0", GITHUB_SHA: commit },
      { version: "0.2.0" },
    );

    expect(verifyReleaseCommit(metadata, runGit)).toBe(commit);
    expect(calls.at(-1)).toEqual(["merge-base", "--is-ancestor", commit, "origin/main"]);
  });

  test("rejects a tagged commit outside origin/main", () => {
    const runGit: GitExecutor = (args) => {
      if (args[0] === "merge-base") return { exitCode: 1, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: commit, stderr: "" };
    };
    const metadata = parseReleaseMetadata(
      { GITHUB_REF_NAME: "v0.2.0", GITHUB_SHA: commit },
      { version: "0.2.0" },
    );

    expect(() => verifyReleaseCommit(metadata, runGit)).toThrow("does not belong to origin/main");
  });

  test("rejects a release event that does not point at the tagged commit", () => {
    const otherCommit = "b".repeat(40);
    let resolution = 0;
    const runGit: GitExecutor = () => {
      resolution += 1;
      return { exitCode: 0, stdout: resolution === 2 ? otherCommit : commit, stderr: "" };
    };
    const metadata = parseReleaseMetadata(
      { GITHUB_REF_NAME: "v0.2.0", GITHUB_SHA: commit },
      { version: "0.2.0" },
    );

    expect(() => verifyReleaseCommit(metadata, runGit)).toThrow("do not resolve to the same commit");
  });
});
