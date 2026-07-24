import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  releaseContractCommands,
  runReleaseContract,
  type ReleaseContractExecutor,
} from "../scripts/release-contract";

const binary = resolve(import.meta.dir, "../dist/asana-cli");

describe("release compatibility contract", () => {
  test("pins generated skills, client evidence, lifecycle, package content, protocol and security", () => {
    const commands = releaseContractCommands(binary).map((command) => command.join(" "));
    expect(commands).toContain("bun run check:generated-integrations");
    expect(commands).toContain("bun run check:client-compatibility");
    expect(commands).toContain("bun run check:v1-audit");
    expect(commands).toContain("bun run check:release-workflow");
    expect(commands).toContain("bun run check:client-evidence");
    expect(commands).toContain("bun run check:native-client-evidence");
    expect(commands).toContain("bun run check:integration-lifecycle-evidence");
    expect(commands).toContain(`bun run check:package-content -- ${binary}`);
    expect(commands).toContain(`bun run --no-env-file scripts/check-v1-examples.ts ${binary}`);
    expect(commands.at(-1)).toContain("tests/agent-protocol.test.ts");
    expect(commands.at(-1)).toContain("tests/agent-v02-compat.test.ts");
    expect(commands.at(-1)).toContain("tests/security.test.ts");
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
