import { describe, expect, test } from "bun:test";
import {
  qualityGateSteps,
  runQualityGate,
  type QualityGateExecutor,
} from "../scripts/quality-gate";

describe("maintainer quality gate", () => {
  test("keeps fast, CI, and release profiles explicit and ordered", () => {
    const fast = qualityGateSteps("fast");
    const ci = qualityGateSteps("ci");
    const release = qualityGateSteps("release");

    expect(fast[0]?.command).toEqual(["bun", "run", "typecheck"]);
    expect(fast.map((step) => step.name)).not.toContain("client evidence");
    expect(ci.map((step) => step.name)).toContain("client evidence");
    expect(ci.at(-1)?.command).toEqual(["./dist/asana-cli", "--version"]);
    expect([...release.slice(0, ci.length)]).toEqual([...ci]);
    expect(release.at(-1)?.command).toEqual([
      "bun",
      "run",
      "release:contract",
      "--",
      "dist/asana-cli",
    ]);
  });

  test("stops on the first failed named step", async () => {
    const expected = qualityGateSteps("fast");
    const calls: string[][] = [];
    const executor: QualityGateExecutor = async (command) => {
      calls.push([...command]);
      return { exitCode: calls.length === 3 ? 1 : 0 };
    };

    expect(runQualityGate("fast", executor)).rejects.toThrow(
      "Quality gate failed at client compatibility",
    );
    expect(calls).toEqual(
      expected.slice(0, 3).map((step) => [...step.command]),
    );
  });
});
