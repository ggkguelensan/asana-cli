import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/args";
import {
  runDoctorCommand,
  type DoctorDependencies,
} from "../src/doctor";
import type { LatestRelease } from "../src/self-update";

const latest: LatestRelease = {
  tag: "v9.0.0",
  version: "9.0.0",
  url: "https://github.com/ggkguelensan/asana-cli/releases/tag/v9.0.0",
  artifact: {
    name: "asana-cli-darwin-arm64",
    size: 1,
    sha256: "a".repeat(64),
    download_url:
      "https://github.com/ggkguelensan/asana-cli/releases/download/v9.0.0/asana-cli-darwin-arm64",
  },
  checksums: {
    name: "SHA256SUMS",
    size: 1,
    sha256: "b".repeat(64),
    download_url:
      "https://github.com/ggkguelensan/asana-cli/releases/download/v9.0.0/SHA256SUMS",
  },
  formula: {
    name: "asana-cli.rb",
    size: 1,
    sha256: "c".repeat(64),
    download_url:
      "https://github.com/ggkguelensan/asana-cli/releases/download/v9.0.0/asana-cli.rb",
  },
};

function dependencies(): DoctorDependencies {
  return {
    resolveTarget: async () => ({
      platform: "darwin",
      architecture: "arm64",
      libc: "native",
      artifact: "asana-cli-darwin-arm64",
    }),
    detectInstallation: async () => ({
      kind: "standalone",
      executable: process.execPath,
      update_target: process.execPath,
    }),
    findOnPath: () => process.execPath,
    probeLog: async () => ({
      path: "/state/asana-cli/audit/invocations.jsonl",
      ready: true,
    }),
    probeCredential: async (offline) => ({
      configured: true,
      source: "os-credential-store",
      verified: !offline,
      status: offline ? "skipped" : "ok",
      message: offline ? "Skipped" : "Asana authentication succeeded",
    }),
    fetchLatestRelease: async () => latest,
  };
}

describe("doctor command", () => {
  test("reports local diagnostics without network in offline mode", async () => {
    let releaseRequests = 0;
    const report = await runDoctorCommand(parseArgs(["doctor", "--offline"]), {
      ...dependencies(),
      fetchLatestRelease: async () => {
        releaseRequests += 1;
        return latest;
      },
    }) as Record<string, unknown>;

    expect(releaseRequests).toBe(0);
    expect(report).toMatchObject({
      schema: "asana-cli.doctor.v1",
      offline: true,
      status: "ok",
      summary: { errors: 0, skipped: 2 },
    });
    expect(JSON.stringify(report)).toContain("invocations.jsonl");
  });

  test("aggregates warnings and actionable suggestions instead of failing early", async () => {
    const report = await runDoctorCommand(parseArgs(["doctor"]), {
      ...dependencies(),
      findOnPath: () => null,
      probeCredential: async () => ({
        configured: false,
        source: null,
        verified: false,
        status: "warning",
        message: "No Asana PAT is configured",
      }),
    }) as Record<string, unknown>;

    expect(report).toMatchObject({
      status: "warning",
      summary: { errors: 0, warnings: 3 },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).toContain("asana-cli auth pat set");
    expect(serialized).toContain("asana-cli update");
    expect(serialized).not.toContain("PAT_CANARY");
  });

  test("reports unsafe log storage as an error without backend details", async () => {
    const report = await runDoctorCommand(parseArgs(["doctor", "--offline"]), {
      ...dependencies(),
      probeLog: async () => {
        throw new Error("PRIVATE_BACKEND_PATH_CANARY");
      },
    }) as Record<string, unknown>;

    expect(report).toMatchObject({
      status: "error",
      summary: { errors: 1 },
    });
    expect(JSON.stringify(report)).not.toContain("PRIVATE_BACKEND_PATH_CANARY");
  });

  test("rejects unknown flags", () => {
    expect(runDoctorCommand(parseArgs(["doctor", "--verbose"]), dependencies()))
      .rejects.toThrow("Unsupported option");
    expect(runDoctorCommand(
      parseArgs(["doctor", "--offline", "--offline"]),
      dependencies(),
    )).rejects.toThrow("only once");
  });
});
