import { describe, expect, test } from "bun:test";
import { booleanFlag, parseArgs, stringFlag } from "../src/args";

describe("argument parsing", () => {
  test("accepts stdin marker as an option value", () => {
    const args = parseArgs(["agent", "my-tasks", "--input", "-"]);
    expect(args.positionals).toEqual(["agent", "my-tasks"]);
    expect(stringFlag(args, "input")).toBe("-");
  });

  test("parses explicit and negated booleans", () => {
    const args = parseArgs(["tasks", "mine", "--all", "--no-compact"]);
    expect(booleanFlag(args, "all")).toBe(true);
    expect(booleanFlag(args, "compact", true)).toBe(false);
  });

  test("supports equals syntax for JSON", () => {
    const args = parseArgs(["api", "call", "TasksApi", "getTask", "--args=[\"1\"]"]);
    expect(stringFlag(args, "args")).toBe('["1"]');
  });
});
