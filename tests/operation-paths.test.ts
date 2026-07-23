import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveOperationJournalDirectory } from "../src/operations/paths";

describe("operation journal paths", () => {
  test("prefers a validated XDG state directory on Linux", () => {
    const directory = resolveOperationJournalDirectory({
      HOME: "/tmp/home",
      XDG_STATE_HOME: "/tmp/xdg-state",
    }, "linux");
    expect(directory).toBe(join("/tmp/xdg-state", "asana-cli", "operations"));
  });

  test("uses the macOS application support directory from HOME", () => {
    const directory = resolveOperationJournalDirectory({ HOME: "/tmp/home" }, "darwin");
    expect(directory).toBe(join(
      "/tmp/home",
      "Library",
      "Application Support",
      "asana-cli",
      "operations",
    ));
  });

  test("rejects relative environment paths", () => {
    expect(() => resolveOperationJournalDirectory({
      HOME: "relative/home",
    }, "linux")).toThrow("must be an absolute path");
  });
});
