import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/args";
import {
  compareSemver,
  detectInstallation,
  downloadVerifiedReleaseArtifact,
  fetchLatestRelease,
  replaceStandaloneExecutable,
  resolveReleaseTarget,
  runUpdateCommand,
  type FetchLike,
  type LatestRelease,
  type UpdateCommandDependencies,
  type VerifiedReleaseArtifact,
} from "../src/self-update";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function response(bytes: Uint8Array, status = 200): Response {
  const body = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Response(body, {
    status,
    headers: { "content-length": String(bytes.byteLength) },
  });
}

function releaseFixture(): Readonly<{
  metadata: unknown;
  binary: Uint8Array;
  checksums: Uint8Array;
  formula: Uint8Array;
}> {
  const binary = new TextEncoder().encode("standalone release binary\n");
  const binaryDigest = sha256(binary);
  const checksums = new TextEncoder().encode(
    `${binaryDigest}  asana-cli-darwin-arm64\n`,
  );
  const checksumsDigest = sha256(checksums);
  const formula = new TextEncoder().encode("class AsanaCli < Formula\nend\n");
  const formulaDigest = sha256(formula);
  return {
    binary,
    checksums,
    formula,
    metadata: {
      tag_name: "v1.2.0",
      html_url: "https://github.com/ggkguelensan/asana-cli/releases/tag/v1.2.0",
      draft: false,
      prerelease: false,
      assets: [
        {
          name: "asana-cli-darwin-arm64",
          size: binary.byteLength,
          digest: `sha256:${binaryDigest}`,
          browser_download_url:
            "https://github.com/ggkguelensan/asana-cli/releases/download/v1.2.0/asana-cli-darwin-arm64",
        },
        {
          name: "SHA256SUMS",
          size: checksums.byteLength,
          digest: `sha256:${checksumsDigest}`,
          browser_download_url:
            "https://github.com/ggkguelensan/asana-cli/releases/download/v1.2.0/SHA256SUMS",
        },
        {
          name: "asana-cli.rb",
          size: formula.byteLength,
          digest: `sha256:${formulaDigest}`,
          browser_download_url:
            "https://github.com/ggkguelensan/asana-cli/releases/download/v1.2.0/asana-cli.rb",
        },
      ],
    },
  };
}

describe("self-update release contract", () => {
  test("compares stable and prerelease semantic versions", () => {
    expect(compareSemver("1.2.0", "1.1.9")).toBe(1);
    expect(compareSemver("1.2.0", "1.2.0")).toBe(0);
    expect(compareSemver("1.2.0-beta.2", "1.2.0-beta.10")).toBe(-1);
    expect(compareSemver("1.2.0", "1.2.0-rc.1")).toBe(1);
  });

  test("selects exact native and musl artifacts", async () => {
    expect(await resolveReleaseTarget({
      platform: "darwin",
      architecture: "arm64",
    })).toMatchObject({ artifact: "asana-cli-darwin-arm64", libc: "native" });
    expect(await resolveReleaseTarget({
      platform: "linux",
      architecture: "x64",
      libc: "musl",
    })).toMatchObject({ artifact: "asana-cli-linux-x64-musl", libc: "musl" });
    expect(resolveReleaseTarget({
      platform: "win32",
      architecture: "x64",
    })).rejects.toThrow("macOS and Linux");
  });

  test("binds the executable to both GitHub asset digests and SHA256SUMS", async () => {
    const fixture = releaseFixture();
    const metadataBytes = new TextEncoder().encode(JSON.stringify(fixture.metadata));
    const fetcher: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes("api.github.com")) return response(metadataBytes);
      if (url.endsWith("/SHA256SUMS")) return response(fixture.checksums);
      if (url.endsWith("/asana-cli.rb")) return response(fixture.formula);
      return response(fixture.binary);
    };
    const target = await resolveReleaseTarget({
      platform: "darwin",
      architecture: "arm64",
    });
    const release = await fetchLatestRelease(target, fetcher);
    const artifact = await downloadVerifiedReleaseArtifact(release, fetcher);

    expect(release).toMatchObject({
      tag: "v1.2.0",
      version: "1.2.0",
      artifact: { name: "asana-cli-darwin-arm64" },
    });
    expect(artifact.sha256).toBe(sha256(fixture.binary));

    const tamperedFetcher: FetchLike = async (input) => {
      const url = String(input);
      if (url.endsWith("/SHA256SUMS")) return response(fixture.checksums);
      return response(new TextEncoder().encode("tampered\n"));
    };
    expect(downloadVerifiedReleaseArtifact(release, tamperedFetcher)).rejects.toThrow(
      "size does not match",
    );
  });

  test("checks, delegates managed installs, and atomically applies standalone updates", async () => {
    const calls: string[] = [];
    const artifact: VerifiedReleaseArtifact = {
      bytes: new TextEncoder().encode("binary"),
      sha256: "a".repeat(64),
    };
    const latest: LatestRelease = {
      tag: "v1.2.0",
      version: "1.2.0",
      url: "https://github.com/ggkguelensan/asana-cli/releases/tag/v1.2.0",
      artifact: {
        name: "asana-cli-darwin-arm64",
        size: 6,
        sha256: "a".repeat(64),
        download_url:
          "https://github.com/ggkguelensan/asana-cli/releases/download/v1.2.0/asana-cli-darwin-arm64",
      },
      checksums: {
        name: "SHA256SUMS",
        size: 1,
        sha256: "b".repeat(64),
        download_url:
          "https://github.com/ggkguelensan/asana-cli/releases/download/v1.2.0/SHA256SUMS",
      },
      formula: {
        name: "asana-cli.rb",
        size: 1,
        sha256: "c".repeat(64),
        download_url:
          "https://github.com/ggkguelensan/asana-cli/releases/download/v1.2.0/asana-cli.rb",
      },
    };
    const dependencies: UpdateCommandDependencies = {
      resolveTarget: () => resolveReleaseTarget({
        platform: "darwin",
        architecture: "arm64",
      }),
      detectInstallation: async () => ({
        kind: "standalone",
        executable: "/tmp/asana-cli",
        update_target: "/tmp/asana-cli",
      }),
      fetchLatestRelease: async () => latest,
      downloadArtifact: async () => {
        calls.push("download");
        return artifact;
      },
      replaceExecutable: async (_path, _artifact, version) => {
        calls.push(`replace:${version}`);
      },
      updateManaged: async (installation, _release, reinstall) => {
        calls.push(`managed:${installation.kind}:${reinstall}`);
        return {
          manager: installation.kind === "homebrew" ? "homebrew" : "bun",
          command: ["manager", "update"],
        };
      },
    };

    const checked = await runUpdateCommand(parseArgs(["update", "--check"]), dependencies);
    expect(checked).toMatchObject({ status: "update-available", changed: false });
    expect(calls).toEqual([]);

    const updated = await runUpdateCommand(parseArgs(["update"]), dependencies);
    expect(updated).toMatchObject({
      status: "updated",
      changed: true,
      verification: { sha256: artifact.sha256 },
    });
    expect(calls).toEqual(["download", "replace:1.2.0"]);

    const managed = await runUpdateCommand(parseArgs(["update"]), {
      ...dependencies,
      detectInstallation: async () => ({
        kind: "bun",
        executable: "/Users/test/.bun/bin/bun",
        update_target: null,
      }),
    });
    expect(managed).toMatchObject({
      status: "updated",
      changed: true,
      manager: "bun",
    });
    expect(calls).toContain("managed:bun:false");
  });

  test("stages and smoke-tests a replacement before atomic rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "asana-cli-self-update-"));
    try {
      const executable = join(root, "asana-cli");
      const script = new TextEncoder().encode("#!/bin/sh\nprintf '1.2.3\\n'\n");
      await writeFile(executable, "#!/bin/sh\nprintf '1.0.0\\n'\n", { mode: 0o755 });
      await chmod(executable, 0o755);
      await replaceStandaloneExecutable(executable, {
        bytes: script,
        sha256: sha256(script),
      }, "1.2.3");
      expect(await readFile(executable, "utf8")).toBe(new TextDecoder().decode(script));

      expect(await detectInstallation(executable)).toMatchObject({
        kind: "standalone",
        update_target: await realpath(executable),
      });
      expect(await detectInstallation(process.execPath)).toMatchObject({
        kind: "bun",
        update_target: null,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not downgrade a development build", async () => {
    const older = "0.0.0";
    const dependencies: UpdateCommandDependencies = {
      resolveTarget: () => resolveReleaseTarget({
        platform: "darwin",
        architecture: "arm64",
      }),
      detectInstallation: async () => ({
        kind: "standalone",
        executable: "/tmp/asana-cli",
        update_target: "/tmp/asana-cli",
      }),
      fetchLatestRelease: async () => ({
        tag: `v${older}`,
        version: older,
        url: `https://github.com/ggkguelensan/asana-cli/releases/tag/v${older}`,
        artifact: {
          name: "asana-cli-darwin-arm64",
          size: 1,
          sha256: "a".repeat(64),
          download_url: "https://example.invalid/binary",
        },
        checksums: {
          name: "SHA256SUMS",
          size: 1,
          sha256: "b".repeat(64),
          download_url: "https://example.invalid/SHA256SUMS",
        },
        formula: {
          name: "asana-cli.rb",
          size: 1,
          sha256: "c".repeat(64),
          download_url: "https://example.invalid/asana-cli.rb",
        },
      }),
      downloadArtifact: async () => {
        throw new Error("must not download");
      },
      replaceExecutable: async () => {
        throw new Error("must not replace");
      },
      updateManaged: async () => {
        throw new Error("must not update");
      },
    };
    expect(await runUpdateCommand(parseArgs(["update", "--force"]), dependencies))
      .toMatchObject({
        status: "development-build-newer-than-release",
        changed: false,
      });
  });

  test("rejects duplicate and conflicting update modes", async () => {
    const never = {
      ...defaultNeverUpdateDependencies(),
    };
    expect(runUpdateCommand(parseArgs(["update", "--check", "--check"]), never))
      .rejects.toThrow("only once");
    expect(runUpdateCommand(parseArgs(["update", "--check", "--force"]), never))
      .rejects.toThrow("cannot be combined");
  });
});

function defaultNeverUpdateDependencies(): UpdateCommandDependencies {
  const fail = async (): Promise<never> => {
    throw new Error("dependencies must not be called for invalid arguments");
  };
  return {
    resolveTarget: fail,
    detectInstallation: fail,
    fetchLatestRelease: fail,
    downloadArtifact: fail,
    replaceExecutable: fail,
    updateManaged: fail,
  };
}
