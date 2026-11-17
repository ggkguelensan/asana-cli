import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  releaseContractCommands,
  runReleaseContract,
  type ReleaseContractExecutor,
} from "../scripts/release-contract";

const binary = resolve(import.meta.dir, "../dist/asana-cli");

describe("release compatibility contract", () => {
  test("checks supported targets, release safety and the compiled CLI", () => {
    expect(releaseContractCommands(binary)).toEqual([
      ["bun", "run", "check:support-matrix"],
      ["bun", "run", "check:release-workflow"],
      ["bun", "run", "check:package-content", "--", binary],
    ]);
  });

  test("runs in order and stops at the first failed contract gate", async () => {
    const expected = releaseContractCommands(binary);
    const calls: string[][] = [];
    const executor: ReleaseContractExecutor = async (command) => {
      calls.push([...command]);
      return { exitCode: calls.length === 3 ? 1 : 0 };
    };

    expect(runReleaseContract(binary, executor)).rejects.toThrow(
      `Release contract failed: ${expected[2]?.join(" ")}`,
    );
    expect(calls).toEqual(expected.slice(0, 3).map((command) => [...command]));
  });
});
