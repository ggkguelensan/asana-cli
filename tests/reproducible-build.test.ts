import { describe, expect, test } from "bun:test";
import {
  createReproducibleBuildEvidence,
  reproducibleBuildEvidenceSchema,
} from "../scripts/reproducible-build";

const bytes = new TextEncoder().encode("same standalone executable bytes\n");
const baseInput = {
  target: "bun-darwin-arm64" as const,
  sourceCommit: "a".repeat(40),
  sourceDateEpoch: 1_700_000_000,
  bunVersion: "1.3.14",
  lockText: "locked dependencies\n",
  buildRecipeSha256: "b".repeat(64),
  artifactName: "asana-cli-darwin-arm64",
  referenceBytes: bytes,
  rebuildBytes: bytes,
};

describe("reproducible release build evidence", () => {
  test("records only normalized byte-identical evidence", async () => {
    const evidence = await createReproducibleBuildEvidence(baseInput);
    expect(reproducibleBuildEvidenceSchema.parse(evidence)).toEqual(evidence);
    expect(evidence.reference.sha256).toBe(evidence.rebuild.sha256);
    expect(evidence.reference.size_bytes).toBe(bytes.byteLength);
    expect(evidence.comparison).toBe("byte-identical");
    expect(evidence.normalized_differences).toEqual([]);
    expect(evidence.build_command).toEqual([
      "bun",
      "run",
      "--no-env-file",
      "scripts/build.ts",
      "bun-darwin-arm64",
      "<output>",
    ]);
    expect(JSON.stringify(evidence)).not.toContain("/tmp/");
  });

  test("fails instead of normalizing a byte or target mismatch", async () => {
    expect(createReproducibleBuildEvidence({
      ...baseInput,
      rebuildBytes: new TextEncoder().encode("different bytes\n"),
    })).rejects.toThrow("Reproducibility mismatch");
    expect(createReproducibleBuildEvidence({
      ...baseInput,
      artifactName: "asana-cli-linux-arm64",
    })).rejects.toThrow("must describe asana-cli-darwin-arm64");
  });

  test("rejects evidence that claims explained differences without byte identity", async () => {
    const evidence = await createReproducibleBuildEvidence(baseInput);
    expect(() => reproducibleBuildEvidenceSchema.parse({
      ...evidence,
      comparison: "normalized",
      normalized_differences: ["timestamp"],
    })).toThrow();
  });
});
