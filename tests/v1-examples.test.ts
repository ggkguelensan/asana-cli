import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  runV1Examples,
  validateV1WorkflowDocumentation,
  V1_DOCUMENTED_COMMANDS,
} from "../scripts/check-v1-examples";

const projectRoot = resolve(import.meta.dir, "..");

describe("critical v1 workflow examples", () => {
  test("executes installation, auth, permission, and recovery against the compiled binary", async () => {
    const result = await runV1Examples(resolve(projectRoot, "dist", "asana-cli"));

    expect(result).toEqual({ commands: 12, workflows: 4 });
  }, 15_000);

  test("rejects documentation that drops any executable critical command", async () => {
    const markdown = await readFile(resolve(projectRoot, "docs", "v1-workflows.md"), "utf8");
    validateV1WorkflowDocumentation(markdown);

    for (const command of V1_DOCUMENTED_COMMANDS) {
      expect(() => validateV1WorkflowDocumentation(markdown.replace(command, ""))).toThrow(
        `Critical workflow documentation is missing command: ${command}`,
      );
    }
  });
});
