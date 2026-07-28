import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { booleanFlag, type ParsedArgs } from "./args";
import { CliError } from "./errors";
import { CLI_VERSION } from "./version";

export const ASANA_CLI_REPOSITORY = "ggkguelensan/asana-cli" as const;
export const GITHUB_RELEASES_API =
  `https://api.github.com/repos/${ASANA_CLI_REPOSITORY}/releases/latest` as const;
const MAX_RELEASE_METADATA_BYTES = 1_048_576;
const MAX_CHECKSUM_BYTES = 65_536;
const MAX_FORMULA_BYTES = 256 * 1_024;
const MAX_BINARY_BYTES = 256 * 1_048_576;
const UPDATE_TIMEOUT_MS = 30_000;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const assetDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const releaseTagSchema = z.string().regex(
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/,
);
const semverSchema = z.string().regex(
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/,
);

const githubReleaseAssetSchema = z.looseObject({
  name: z.string(),
  size: z.number().int().positive().max(MAX_BINARY_BYTES),
  digest: assetDigestSchema,
  browser_download_url: z.url(),
});

const githubReleaseSchema = z.looseObject({
  tag_name: releaseTagSchema,
  html_url: z.url(),
  draft: z.literal(false),
  prerelease: z.literal(false),
  assets: z.array(githubReleaseAssetSchema),
});

export type ReleaseTarget = Readonly<{
  platform: "darwin" | "linux";
  architecture: "arm64" | "x64";
  libc: "native" | "musl";
  artifact: string;
}>;

export type Installation = Readonly<{
  kind: "standalone" | "bun" | "homebrew";
  executable: string;
  update_target: string | null;
}>;

export type LatestRelease = Readonly<{
  tag: string;
  version: string;
  url: string;
  artifact: Readonly<{
    name: string;
    size: number;
    sha256: string;
    download_url: string;
  }>;
  checksums: Readonly<{
    name: "SHA256SUMS";
    size: number;
    sha256: string;
    download_url: string;
  }>;
  formula: Readonly<{
    name: "asana-cli.rb";
    size: number;
    sha256: string;
    download_url: string;
  }>;
}>;

export type VerifiedReleaseArtifact = Readonly<{
  bytes: Uint8Array;
  sha256: string;
}>;

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type UpdateCommandDependencies = Readonly<{
  resolveTarget: () => Promise<ReleaseTarget>;
  detectInstallation: () => Promise<Installation>;
  fetchLatestRelease: (target: ReleaseTarget) => Promise<LatestRelease>;
  downloadArtifact: (release: LatestRelease) => Promise<VerifiedReleaseArtifact>;
  replaceExecutable: (
    executable: string,
    artifact: VerifiedReleaseArtifact,
    expectedVersion: string,
  ) => Promise<void>;
  updateManaged: (
    installation: Installation,
    release: LatestRelease,
    reinstall: boolean,
  ) => Promise<Readonly<{ manager: "bun" | "homebrew"; command: readonly string[] }>>;
}>;

type ParsedSemver = Readonly<{
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly string[];
}>;

function parseSemver(value: string): ParsedSemver {
  const parsed = semverSchema.safeParse(value);
  if (!parsed.success) throw new CliError("validation", `Invalid semantic version: ${value}`);
  const match = semverSchema.parse(value).match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/,
  );
  if (!match) throw new CliError("validation", `Invalid semantic version: ${value}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareIdentifier(left: string, right: string): number {
  if (left === right) return 0;
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Number(left) < Number(right) ? -1 : 1;
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : 1;
}

export function compareSemver(leftValue: string, rightValue: string): number {
  const left = parseSemver(leftValue);
  const right = parseSemver(rightValue);
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === undefined ? -1 : 1;
    }
    const comparison = compareIdentifier(leftIdentifier, rightIdentifier);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

async function detectLinuxLibc(): Promise<"native" | "musl"> {
  const executable = Bun.which("ldd");
  if (!executable) return "native";
  const child = Bun.spawn([executable, "--version"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return /musl/i.test(`${stdout}\n${stderr}`) ? "musl" : "native";
}

export async function resolveReleaseTarget(
  input: Readonly<{
    platform?: string;
    architecture?: string;
    libc?: "native" | "musl";
  }> = {},
): Promise<ReleaseTarget> {
  const platform = input.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") {
    throw new CliError("unsupported-platform", "Self-update supports macOS and Linux only");
  }
  const architecture = input.architecture ?? process.arch;
  if (architecture !== "arm64" && architecture !== "x64") {
    throw new CliError(
      "unsupported-platform",
      `Self-update does not publish an artifact for architecture ${architecture}`,
    );
  }
  const libc = platform === "linux"
    ? input.libc ?? await detectLinuxLibc()
    : "native";
  return {
    platform,
    architecture,
    libc,
    artifact: [
      "asana-cli",
      platform,
      architecture,
      ...(libc === "musl" ? ["musl"] : []),
    ].join("-"),
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateDownloadUrl(value: string, tag: string, name: string): string {
  const url = new URL(value);
  const expectedPath =
    `/${ASANA_CLI_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.pathname !== expectedPath) {
    throw new CliError("validation", `GitHub release returned an unsafe download URL for ${name}`);
  }
  return url.toString();
}

function validateReleaseUrl(value: string, tag: string): string {
  const url = new URL(value);
  const expectedPath = `/${ASANA_CLI_REPOSITORY}/releases/tag/${encodeURIComponent(tag)}`;
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.pathname !== expectedPath) {
    throw new CliError("validation", "GitHub release returned an unsafe release URL");
  }
  return url.toString();
}

async function fetchBytes(
  url: string,
  maximumBytes: number,
  fetcher: FetchLike,
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetcher(url, {
      redirect: "follow",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `asana-cli/${CLI_VERSION}`,
      },
      signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS),
    });
  } catch {
    throw new CliError("network", "Unable to reach GitHub Releases");
  }
  if (!response.ok) {
    throw new CliError(
      "network",
      `GitHub Releases returned HTTP ${response.status}`,
    );
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maximumBytes) {
    throw new CliError("validation", "GitHub release response exceeds the safety limit");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
    throw new CliError("validation", "GitHub release response has an invalid size");
  }
  return bytes;
}

export async function fetchLatestRelease(
  target: ReleaseTarget,
  fetcher: FetchLike = fetch,
): Promise<LatestRelease> {
  const metadataBytes = await fetchBytes(
    GITHUB_RELEASES_API,
    MAX_RELEASE_METADATA_BYTES,
    fetcher,
  );
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(metadataBytes)) as unknown;
  } catch {
    throw new CliError("validation", "GitHub release metadata is not valid UTF-8 JSON");
  }
  const parsed = githubReleaseSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new CliError("validation", "GitHub release metadata has an unexpected schema");
  }
  const release = parsed.data;
  const selected = release.assets.filter((asset) =>
    asset.name === target.artifact ||
    asset.name === "SHA256SUMS" ||
    asset.name === "asana-cli.rb"
  );
  if (
    selected.length !== 3 ||
    new Set(selected.map(({ name }) => name)).size !== 3
  ) {
    throw new CliError(
      "not-found",
      `Release ${release.tag_name} is missing the binary, SHA256SUMS, or Homebrew formula`,
    );
  }
  const artifact = selected.find(({ name }) => name === target.artifact);
  const checksums = selected.find(({ name }) => name === "SHA256SUMS");
  const formula = selected.find(({ name }) => name === "asana-cli.rb");
  if (!artifact || !checksums || !formula) {
    throw new CliError("not-found", "Required GitHub release assets are missing");
  }
  if (checksums.size > MAX_CHECKSUM_BYTES) {
    throw new CliError("validation", "SHA256SUMS exceeds the safety limit");
  }
  if (formula.size > MAX_FORMULA_BYTES) {
    throw new CliError("validation", "Homebrew formula exceeds the safety limit");
  }
  const version = release.tag_name.slice(1);
  parseSemver(version);
  return {
    tag: release.tag_name,
    version,
    url: validateReleaseUrl(release.html_url, release.tag_name),
    artifact: {
      name: artifact.name,
      size: artifact.size,
      sha256: artifact.digest.slice("sha256:".length),
      download_url: validateDownloadUrl(
        artifact.browser_download_url,
        release.tag_name,
        artifact.name,
      ),
    },
    checksums: {
      name: "SHA256SUMS",
      size: checksums.size,
      sha256: checksums.digest.slice("sha256:".length),
      download_url: validateDownloadUrl(
        checksums.browser_download_url,
        release.tag_name,
        checksums.name,
      ),
    },
    formula: {
      name: "asana-cli.rb",
      size: formula.size,
      sha256: formula.digest.slice("sha256:".length),
      download_url: validateDownloadUrl(
        formula.browser_download_url,
        release.tag_name,
        formula.name,
      ),
    },
  };
}

function selectedChecksum(text: string, artifact: string): string {
  if (!text.endsWith("\n")) {
    throw new CliError("validation", "SHA256SUMS must end with a newline");
  }
  const matches = text
    .slice(0, -1)
    .split("\n")
    .filter((line) => line.endsWith(`  ${artifact}`));
  if (matches.length !== 1) {
    throw new CliError("validation", `SHA256SUMS must contain exactly one ${artifact} record`);
  }
  const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9.-]*)$/.exec(matches[0]!);
  if (!match || match[2] !== artifact) {
    throw new CliError("validation", `SHA256SUMS contains a malformed ${artifact} record`);
  }
  return sha256Schema.parse(match[1]);
}

export async function downloadVerifiedReleaseArtifact(
  release: LatestRelease,
  fetcher: FetchLike = fetch,
): Promise<VerifiedReleaseArtifact> {
  const [checksumBytes, binaryBytes] = await Promise.all([
    fetchBytes(release.checksums.download_url, MAX_CHECKSUM_BYTES, fetcher),
    fetchBytes(release.artifact.download_url, MAX_BINARY_BYTES, fetcher),
  ]);
  if (
    checksumBytes.byteLength !== release.checksums.size ||
    sha256(checksumBytes) !== release.checksums.sha256
  ) {
    throw new CliError("validation", "SHA256SUMS does not match GitHub release metadata");
  }
  if (binaryBytes.byteLength !== release.artifact.size) {
    throw new CliError("validation", "Downloaded executable size does not match GitHub release metadata");
  }
  const manifestText = new TextDecoder("utf8", { fatal: true }).decode(checksumBytes);
  const manifestDigest = selectedChecksum(manifestText, release.artifact.name);
  const binaryDigest = sha256(binaryBytes);
  if (
    binaryDigest !== release.artifact.sha256 ||
    binaryDigest !== manifestDigest
  ) {
    throw new CliError(
      "validation",
      "Downloaded executable failed GitHub digest and SHA256SUMS verification",
    );
  }
  return { bytes: binaryBytes, sha256: binaryDigest };
}

function isHomebrewPath(path: string): boolean {
  return /\/(?:homebrew|linuxbrew\/\.linuxbrew)\/Cellar\/asana-cli\//.test(path) ||
    /\/Cellar\/asana-cli\//.test(path);
}

export async function detectInstallation(
  executableArgument: string = process.execPath,
): Promise<Installation> {
  const executable = resolve(executableArgument);
  if (/^bun(?:-debug)?(?:\.exe)?$/i.test(basename(executable))) {
    return { kind: "bun", executable, update_target: null };
  }
  let resolvedExecutable: string;
  try {
    resolvedExecutable = await realpath(executable);
  } catch {
    throw new CliError("storage-invalid", "Cannot resolve the current executable path");
  }
  if (isHomebrewPath(resolvedExecutable)) {
    return {
      kind: "homebrew",
      executable: resolvedExecutable,
      update_target: null,
    };
  }
  const stats = await lstat(resolvedExecutable);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new CliError("storage-invalid", "The current executable is not a regular file");
  }
  return {
    kind: "standalone",
    executable: resolvedExecutable,
    update_target: resolvedExecutable,
  };
}

async function verifyCandidate(path: string, expectedVersion: string): Promise<void> {
  const child = Bun.spawn([path, "--version"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? dirname(path),
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (
    exitCode !== 0 ||
    stderr !== "" ||
    stdout !== `${expectedVersion}\n`
  ) {
    throw new CliError(
      "validation",
      "Downloaded executable did not pass the exact version smoke test",
    );
  }
}

export async function replaceStandaloneExecutable(
  executableArgument: string,
  artifact: VerifiedReleaseArtifact,
  expectedVersion: string,
): Promise<void> {
  const executable = resolve(executableArgument);
  const stats = await lstat(executable);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new CliError("storage-invalid", "Refusing to replace a non-regular executable");
  }
  if (typeof process.getuid !== "function" || stats.uid !== process.getuid()) {
    throw new CliError(
      "policy-denied",
      "The current executable is owned by another user; rerun the installer with the intended owner",
    );
  }
  const temporaryDirectory = await mkdtemp(join(dirname(executable), ".asana-cli-update-"));
  const candidate = join(temporaryDirectory, "asana-cli");
  try {
    await writeFile(candidate, artifact.bytes, { mode: 0o700 });
    await chmod(candidate, 0o755);
    if (sha256(await readFile(candidate)) !== artifact.sha256) {
      throw new CliError("validation", "Staged executable changed before installation");
    }
    await verifyCandidate(candidate, expectedVersion);
    await rename(candidate, executable);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      "storage-invalid",
      "Unable to replace the current executable atomically; check directory ownership",
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function managedUpdateCommand(
  installation: Installation,
  release: LatestRelease,
  formulaPath?: string,
  reinstall = false,
): readonly string[] {
  if (installation.kind === "bun") {
    return [
      installation.executable,
      "add",
      "-g",
      "--force",
      `github:${ASANA_CLI_REPOSITORY}#${release.tag}`,
    ];
  }
  const brew = Bun.which("brew");
  if (!brew) throw new CliError("not-found", "Homebrew is not available through PATH");
  if (!formulaPath) throw new CliError("internal", "Homebrew update is missing its verified formula");
  return [brew, reinstall ? "reinstall" : "upgrade", "--formula", formulaPath];
}

async function executeManagedUpdate(
  installation: Installation,
  release: LatestRelease,
  reinstall: boolean,
): Promise<Readonly<{ manager: "bun" | "homebrew"; command: readonly string[] }>> {
  if (installation.kind === "standalone") {
    throw new CliError("internal", "Standalone installation was routed to a package manager");
  }
  let temporaryDirectory: string | undefined;
  let command: readonly string[];
  try {
    if (installation.kind === "homebrew") {
      const formulaBytes = await fetchBytes(
        release.formula.download_url,
        MAX_FORMULA_BYTES,
        fetch,
      );
      if (
        formulaBytes.byteLength !== release.formula.size ||
        sha256(formulaBytes) !== release.formula.sha256
      ) {
        throw new CliError(
          "validation",
          "Homebrew formula does not match GitHub release metadata",
        );
      }
      temporaryDirectory = await mkdtemp(join(tmpdir(), "asana-cli-homebrew-"));
      const formulaPath = join(temporaryDirectory, "asana-cli.rb");
      await writeFile(formulaPath, formulaBytes, { mode: 0o600 });
      command = managedUpdateCommand(installation, release, formulaPath, reinstall);
    } else {
      command = managedUpdateCommand(installation, release);
    }

    const child = Bun.spawn([...command], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: {
        ...process.env,
        ASANA_ACCESS_TOKEN: "",
        ASANA_PAT: "",
      },
    });
    if (await child.exited !== 0) {
      throw new CliError(
        "internal",
        `${installation.kind === "bun" ? "Bun" : "Homebrew"} could not update asana-cli`,
      );
    }
    return { manager: installation.kind, command };
  } finally {
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function requireUpdateArguments(args: ParsedArgs): Readonly<{
  check: boolean;
  force: boolean;
}> {
  if (args.positionals.length !== 1) {
    throw new CliError("usage", "Usage: asana-cli update [--check] [--force]");
  }
  const allowed = new Set(["check", "force", "compact"]);
  for (const [name, value] of Object.entries(args.flags)) {
    if (!allowed.has(name)) {
      throw new CliError("usage", `Unsupported option for update: --${name}`);
    }
    if (Array.isArray(value)) {
      throw new CliError("usage", `--${name} may be provided only once`);
    }
  }
  const check = booleanFlag(args, "check");
  const force = booleanFlag(args, "force");
  if (check && force) throw new CliError("usage", "--check and --force cannot be combined");
  return { check, force };
}

export const defaultUpdateCommandDependencies: UpdateCommandDependencies = {
  resolveTarget: resolveReleaseTarget,
  detectInstallation,
  fetchLatestRelease,
  downloadArtifact: downloadVerifiedReleaseArtifact,
  replaceExecutable: replaceStandaloneExecutable,
  updateManaged: executeManagedUpdate,
};

export async function runUpdateCommand(
  args: ParsedArgs,
  dependencies: UpdateCommandDependencies = defaultUpdateCommandDependencies,
): Promise<unknown> {
  const options = requireUpdateArguments(args);
  const [target, installation] = await Promise.all([
    dependencies.resolveTarget(),
    dependencies.detectInstallation(),
  ]);
  const release = await dependencies.fetchLatestRelease(target);
  const comparison = compareSemver(release.version, CLI_VERSION);
  const common = {
    schema: "asana-cli.update.v1",
    current_version: CLI_VERSION,
    latest_version: release.version,
    release_url: release.url,
    artifact: target.artifact,
    installation: {
      kind: installation.kind,
      executable: installation.executable,
    },
  };
  if (comparison < 0) {
    return {
      ...common,
      status: "development-build-newer-than-release",
      changed: false,
    };
  }
  if (comparison === 0 && !options.force) {
    return { ...common, status: "up-to-date", changed: false };
  }
  if (options.check) {
    return { ...common, status: "update-available", changed: false };
  }
  if (installation.kind !== "standalone" || installation.update_target === null) {
    const execution = await dependencies.updateManaged(
      installation,
      release,
      comparison === 0,
    );
    return {
      ...common,
      status: comparison === 0 ? "reinstalled" : "updated",
      changed: true,
      manager: execution.manager,
      command: execution.command,
    };
  }
  const artifact = await dependencies.downloadArtifact(release);
  await dependencies.replaceExecutable(
    installation.update_target,
    artifact,
    release.version,
  );
  return {
    ...common,
    status: comparison === 0 ? "reinstalled" : "updated",
    changed: true,
    verification: {
      method: "github-release-digest+SHA256SUMS",
      sha256: artifact.sha256,
    },
  };
}
