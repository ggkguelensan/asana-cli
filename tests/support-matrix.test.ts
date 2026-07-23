import { describe, expect, test } from "bun:test";
import {
  extractReleaseTargets,
  parseRequestedBuildTarget,
  RELEASE_TARGETS,
  verifyPosixOnlyProductionSources,
  verifySupportMatrix,
} from "../scripts/check-support-matrix";

const packageScripts = Object.fromEntries(RELEASE_TARGETS.map((target) => [
  `build:${target.output.replace(/^asana-cli-/, "")}`,
  `bun run --no-env-file scripts/build.ts ${target.target} dist/${target.output}`,
]));

const releaseWorkflow = [
  "jobs:",
  "  build:",
  "    strategy:",
  "      matrix:",
  "        include:",
  ...RELEASE_TARGETS.flatMap((target) => [
    `          - target: ${target.target}`,
    `            output: ${target.output}`,
    `            runner: ${target.runner}`,
  ]),
  "  publish:",
  "    needs: build",
  "",
].join("\n");

const supportPolicy = RELEASE_TARGETS
  .map((target) => `- \`${target.output}\``)
  .join("\n");

describe("supported build and release matrix", () => {
  test("accepts only canonical macOS and Linux compile targets", () => {
    expect(parseRequestedBuildTarget(undefined)).toBeUndefined();
    expect(parseRequestedBuildTarget("bun-darwin-arm64")).toBe("bun-darwin-arm64");
    expect(parseRequestedBuildTarget("bun-linux-x64-baseline-musl")).toBe("bun-linux-x64-baseline-musl");
    expect(() => parseRequestedBuildTarget("bun-windows-x64-baseline")).toThrow();
  });

  test("extracts the exact release matrix in stable order", () => {
    expect(extractReleaseTargets(releaseWorkflow)).toEqual(RELEASE_TARGETS);
  });

  test("accepts an exact POSIX support matrix", () => {
    expect(() => verifySupportMatrix({
      packageJson: { scripts: packageScripts },
      ciWorkflow: "jobs:\n  check:\n    runs-on: ubuntu-latest\n",
      releaseWorkflow,
      supportPolicy,
    })).not.toThrow();
  });

  test("rejects native Windows reintroduction in every governed surface", () => {
    expect(() => verifySupportMatrix({
      packageJson: {
        scripts: {
          ...packageScripts,
          "build:windows-x64": "bun run scripts/build.ts bun-windows-x64-baseline out.exe",
        },
      },
      ciWorkflow: "jobs:\n  check:\n    runs-on: ubuntu-latest\n",
      releaseWorkflow,
      supportPolicy,
    })).toThrow("package.json exposes a native Windows build command");

    expect(() => verifySupportMatrix({
      packageJson: { scripts: packageScripts },
      ciWorkflow: "jobs:\n  check:\n    runs-on: windows-latest\n",
      releaseWorkflow,
      supportPolicy,
    })).toThrow("CI workflow contains a native Windows gate");

    expect(() => verifySupportMatrix({
      packageJson: { scripts: packageScripts },
      ciWorkflow: "jobs:\n  check:\n    runs-on: ubuntu-latest\n",
      releaseWorkflow: `${releaseWorkflow}\n# powershell verifier\n`,
      supportPolicy,
    })).toThrow("Release workflow contains a native Windows target or gate");
  });

  test("rejects drift between policy documentation and release artifacts", () => {
    expect(() => verifySupportMatrix({
      packageJson: { scripts: packageScripts },
      ciWorkflow: "jobs:\n  check:\n    runs-on: ubuntu-latest\n",
      releaseWorkflow,
      supportPolicy: supportPolicy.replace("`asana-cli-linux-x64`", "`missing-linux-x64`"),
    })).toThrow("does not document asana-cli-linux-x64");
  });

  test("rejects dormant native Windows implementation branches and assets", () => {
    expect(() => verifyPosixOnlyProductionSources([{
      path: "src/storage.ts",
      content: 'if (process.platform === "win32") return legacyPath;',
    }])).toThrow("src/storage.ts");

    expect(() => verifyPosixOnlyProductionSources([{
      path: "assets/windows-loader.ps1",
      content: "",
    }])).toThrow("assets/windows-loader.ps1");

    expect(() => verifyPosixOnlyProductionSources([{
      path: "src/storage.ts",
      content: "const root = environment.XDG_STATE_HOME;",
    }])).not.toThrow();
  });
});
