import { describe, expect, test } from "bun:test";
import { verifyReleaseWorkflow } from "../scripts/check-release-workflow";

const workflow = await Bun.file(new URL("../.github/workflows/release.yml", import.meta.url)).text();
describe("release supply-chain workflow", () => {
  test("retains Asana CLI smoke checks, SBOM, reproducibility and signing", () => {
    expect(() => verifyReleaseWorkflow(workflow)).not.toThrow();
  });
  test("rejects missing verification and obsolete lifecycle tooling", () => {
    expect(() => verifyReleaseWorkflow(workflow.replaceAll("gh attestation verify", "echo skipped"))).toThrow();
    expect(() => verifyReleaseWorkflow(`${workflow}\n# integration-lifecycle`)).toThrow();
  });
});
