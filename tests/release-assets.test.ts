import { describe, expect, test } from "bun:test";
import {
  buildHomebrewFormula,
} from "../scripts/homebrew-formula";
import {
  buildReleaseChecksums,
  parseReleaseChecksums,
  RELEASE_PAYLOAD_NAMES,
} from "../scripts/release-assets";
import {
  BUILD_PROVENANCE_PREDICATE,
  parseSigstoreBundle,
  SPDX_SBOM_PREDICATE,
} from "../scripts/sigstore-bundle";

function payloadFixtures(): Readonly<Record<string, Uint8Array>> {
  return Object.fromEntries(RELEASE_PAYLOAD_NAMES.map((name) => [
    name,
    new TextEncoder().encode(`release payload ${name}\n`),
  ]));
}

describe("release checksum manifest", () => {
  test("covers the exact release payload set in canonical order", () => {
    const text = buildReleaseChecksums(payloadFixtures());
    const entries = parseReleaseChecksums(text);

    expect(entries.map(({ name }) => name)).toEqual([...RELEASE_PAYLOAD_NAMES]);
    expect(entries).toHaveLength(38);
    expect(entries.every(({ sha256 }) => /^[a-f0-9]{64}$/.test(sha256))).toBeTrue();
    expect(text.endsWith("\n")).toBeTrue();
  });

  test("rejects missing, extra, reordered, duplicate, and malformed records", () => {
    const fixtures = payloadFixtures();
    const missing = { ...fixtures };
    delete (missing as Record<string, Uint8Array>)["asana-cli.rb"];
    expect(() => buildReleaseChecksums(missing)).toThrow("exact canonical payload set");
    expect(() => buildReleaseChecksums({
      ...fixtures,
      "unexpected.txt": new Uint8Array(),
    })).toThrow("exact canonical payload set");

    const valid = buildReleaseChecksums(fixtures);
    const lines = valid.trimEnd().split("\n");
    expect(() => parseReleaseChecksums(`${[...lines].reverse().join("\n")}\n`)).toThrow(
      "canonical release payloads in order",
    );
    expect(() => parseReleaseChecksums(`${lines[0]}\n${lines[0]}\n`)).toThrow(
      "repeats a release payload",
    );
    expect(() => parseReleaseChecksums(valid.replace("  ", " *"))).toThrow(
      "malformed record",
    );
    expect(() => parseReleaseChecksums(valid.trimEnd())).toThrow(
      "must end with one newline",
    );
  });
});

describe("generated Homebrew formula", () => {
  const checksums = {
    "asana-cli-darwin-arm64": "a".repeat(64),
    "asana-cli-darwin-x64": "b".repeat(64),
    "asana-cli-linux-arm64": "c".repeat(64),
    "asana-cli-linux-x64": "d".repeat(64),
  };

  test("pins one checksum-selected executable for each POSIX platform and architecture", () => {
    const formula = buildHomebrewFormula({
      version: "1.2.3",
      tag: "v1.2.3",
      baseUrl: "https://github.com/ggkguelensan/asana-cli/releases/download/v1.2.3",
      checksums,
    });

    expect(formula).toContain("class AsanaCli < Formula");
    expect(formula.match(/using: :nounzip/g)).toHaveLength(4);
    expect(formula.match(/sha256 \"[a-d]{64}\"/g)).toHaveLength(4);
    expect(formula).toContain('bin.install artifact => "asana-cli"');
    expect(formula).toContain('shell_output("#{bin}/asana-cli --version")');
    expect(formula).not.toContain("musl");
    expect(formula).not.toContain("system ");

    const syntax = Bun.spawnSync(["ruby", "-c"], {
      stdin: new TextEncoder().encode(formula),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(syntax.exitCode).toBe(0);
  });

  test("rejects version, transport, checksum, and target drift", () => {
    expect(() => buildHomebrewFormula({
      version: "1.2.3",
      tag: "v1.2.4",
      baseUrl: "https://example.com/v1.2.3",
      checksums,
    })).toThrow("tag must match");
    expect(() => buildHomebrewFormula({
      version: "1.2.3",
      tag: "v1.2.3",
      baseUrl: "http://example.com/v1.2.3",
      checksums,
    })).toThrow("must use HTTPS");
    expect(() => buildHomebrewFormula({
      version: "1.2.3",
      tag: "v1.2.3",
      baseUrl: "https://example.com/v1.2.3",
      checksums: { ...checksums, unexpected: "e".repeat(64) },
    })).toThrow("exactly four");
    expect(() => buildHomebrewFormula({
      version: "1.2.3",
      tag: "v1.2.3",
      baseUrl: "https://example.com/v1.2.3",
      checksums: { ...checksums, "asana-cli-linux-x64": "invalid" },
    })).toThrow();
  });
});

describe("Sigstore release bundle subject", () => {
  const digest = "a".repeat(64);

  function bundle(
    name = "asana-cli-darwin-arm64",
    sha256 = digest,
    predicateType = BUILD_PROVENANCE_PREDICATE,
  ): unknown {
    const statement = {
      _type: "https://in-toto.io/Statement/v1",
      subject: [{ name, digest: { sha256 } }],
      predicateType,
      predicate: {},
    };
    return {
      mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      verificationMaterial: {},
      dsseEnvelope: {
        payloadType: "application/vnd.in-toto+json",
        payload: Buffer.from(JSON.stringify(statement), "utf8").toString("base64"),
        signatures: [{ sig: "a".repeat(64) }],
      },
    };
  }

  test("requires one exact digest-bound SLSA or SPDX subject", () => {
    const expected = {
      name: "asana-cli-darwin-arm64",
      sha256: digest,
      predicateType: BUILD_PROVENANCE_PREDICATE,
    } as const;
    expect(() => parseSigstoreBundle(bundle(), expected)).not.toThrow();
    expect(() => parseSigstoreBundle(bundle(
      expected.name,
      digest,
      SPDX_SBOM_PREDICATE,
    ), {
      ...expected,
      predicateType: SPDX_SBOM_PREDICATE,
    })).not.toThrow();

    expect(() => parseSigstoreBundle(bundle("other"), expected)).toThrow(
      "subject does not match",
    );
    expect(() => parseSigstoreBundle(bundle(expected.name, "b".repeat(64)), expected)).toThrow(
      "subject does not match",
    );
    expect(() => parseSigstoreBundle(
      bundle(expected.name, digest, SPDX_SBOM_PREDICATE),
      expected,
    )).toThrow("unexpected predicate");
    expect(() => parseSigstoreBundle({
      ...(bundle() as Record<string, unknown>),
      verificationMaterial: [],
    }, expected))
      .toThrow();
  });
});
