import { describe, expect, test } from "bun:test";
import {
  evaluateAsanaSdkVersion,
  isBiweeklyAsanaSdkCheckDue,
} from "../scripts/check-asana-sdk-version";

const NOW = new Date("2026-08-03T06:23:00.000Z");

function packageManifest(version: string): unknown {
  return {
    name: "asana-cli",
    dependencies: {
      asana: version,
      zod: "4.4.3",
    },
  };
}

function registry(
  latest: string,
  releases: Readonly<Record<string, string>>,
): unknown {
  return {
    "dist-tags": { latest },
    versions: Object.fromEntries(
      Object.keys(releases).map((version) => [version, { name: "asana" }]),
    ),
    time: releases,
  };
}

describe("Asana Node SDK version watch", () => {
  test("passes when the pinned SDK matches the latest eligible release", () => {
    const result = evaluateAsanaSdkVersion(
      packageManifest("3.1.12"),
      registry("3.1.12", {
        "3.1.11": "2026-05-01T00:00:00.000Z",
        "3.1.12": "2026-06-01T00:00:00.000Z",
      }),
      NOW,
    );

    expect(result.behind).toBe(false);
    expect(result.quarantineEligibleVersion).toBe("3.1.12");
    expect(result.latestInQuarantine).toBe(false);
  });

  test("does not fail while the registry latest release is quarantined", () => {
    const result = evaluateAsanaSdkVersion(
      packageManifest("3.1.12"),
      registry("3.2.0", {
        "3.1.12": "2026-06-01T00:00:00.000Z",
        "3.2.0": "2026-07-28T00:00:00.000Z",
      }),
      NOW,
    );

    expect(result.behind).toBe(false);
    expect(result.latestVersion).toBe("3.2.0");
    expect(result.quarantineEligibleVersion).toBe("3.1.12");
    expect(result.latestInQuarantine).toBe(true);
    expect(result.latestQuarantineEndsAt).toBe("2026-08-11T00:00:00.000Z");
  });

  test("fails the policy result when an eligible SDK release is newer", () => {
    const result = evaluateAsanaSdkVersion(
      packageManifest("3.1.11"),
      registry("3.1.12", {
        "3.1.11": "2026-05-01T00:00:00.000Z",
        "3.1.12": "2026-06-01T00:00:00.000Z",
      }),
      NOW,
    );

    expect(result.behind).toBe(true);
    expect(result.quarantineEligibleVersion).toBe("3.1.12");
  });

  test("rejects ranges and incomplete registry metadata", () => {
    expect(() =>
      evaluateAsanaSdkVersion(
        packageManifest("^3.1.12"),
        registry("3.1.12", {
          "3.1.12": "2026-06-01T00:00:00.000Z",
        }),
        NOW,
      )
    ).toThrow("exact stable semantic version");

    expect(() =>
      evaluateAsanaSdkVersion(
        packageManifest("3.1.12"),
        {
          "dist-tags": { latest: "3.1.12" },
          versions: { "3.1.12": {} },
          time: {},
        },
        NOW,
      )
    ).toThrow("no publication time");
  });

  test("runs on alternating Mondays from the documented anchor", () => {
    expect(isBiweeklyAsanaSdkCheckDue(NOW)).toBe(true);
    expect(
      isBiweeklyAsanaSdkCheckDue(new Date("2026-08-10T06:23:00.000Z")),
    ).toBe(false);
    expect(
      isBiweeklyAsanaSdkCheckDue(new Date("2026-08-17T06:23:00.000Z")),
    ).toBe(true);
  });
});
