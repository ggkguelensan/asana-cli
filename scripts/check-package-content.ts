import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  EMBEDDED_INTEGRATION_BUNDLE,
  embeddedIntegrationBundleSchema,
} from "../generated/integrations/bundle";
import { INTEGRATION_CLIENTS } from "../integrations/clients";
import {
  INTEGRATION_INSTALLER,
  INTEGRATION_MANIFEST_FILE,
  INTEGRATION_MANIFEST_SCHEMA,
  integrationManifestSchema,
} from "../src/integrations";
import { AGENT_PROTOCOL_VERSION, CLI_VERSION } from "../src/version";

const projectRoot = resolve(import.meta.dir, "..");
const packageJsonPath = join(projectRoot, "package.json");
const defaultBinaryPath = join(projectRoot, "dist", "asana-cli");
const [requestedBinaryPath, ...unexpectedArguments] = process.argv.slice(2);

if (unexpectedArguments.length > 0) {
  throw new Error("Usage: bun run check:package-content [binary-path]");
}

const binaryPath = requestedBinaryPath
  ? resolve(process.cwd(), requestedBinaryPath)
  : defaultBinaryPath;

const packageSchema = z.object({ version: z.string().min(1) }).passthrough();
const integrationListingSchema = z.strictObject({
  schema: z.literal("asana-cli.integration-bundle.v1"),
  bundle_version: z.string().min(1),
  agent_protocol_version: z.number().int().positive(),
  runtime: z.strictObject({
    platform: z.enum(["darwin", "linux"]),
    architecture: z.enum(["arm64", "x64"]),
  }),
  clients: z.unknown(),
});

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} did not produce valid JSON`, { cause: error });
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  throw new Error("Artifact metadata must be JSON-compatible");
}

function assertExactJson(actual: unknown, expected: unknown, label: string): void {
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error(`${label} does not exactly match the expected metadata`);
  }
}

function assertExactHashMap(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
  label: string,
): void {
  const actualPaths = Object.keys(actual).sort();
  const expectedPaths = Object.keys(expected).sort();
  if (
    actualPaths.length !== expectedPaths.length ||
    actualPaths.some((path, index) => path !== expectedPaths[index]) ||
    actualPaths.some((path) => actual[path] !== expected[path])
  ) {
    throw new Error(`${label} does not exactly match the expected file hash map`);
  }
}

async function runArtifact(args: readonly string[], cwd: string): Promise<string> {
  const artifact = Bun.spawn({
    cmd: [binaryPath, ...args],
    cwd,
    env: { ...process.env, HOME: cwd },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(artifact.stdout).text(),
    new Response(artifact.stderr).text(),
    artifact.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Artifact command ${args.join(" ")} failed with exit code ${exitCode}: ${stderr}`);
  }
  if (stderr !== "") {
    throw new Error(`Artifact command ${args.join(" ")} wrote to stderr: ${stderr}`);
  }
  return stdout;
}

async function readArtifactFile(path: string, label: string): Promise<Uint8Array> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
  return new Uint8Array(await Bun.file(path).arrayBuffer());
}

async function collectArtifactPaths(directory: string): Promise<string[]> {
  const paths: string[] = [];
  async function visit(currentDirectory: string): Promise<void> {
    for (const entry of await readdir(currentDirectory, { withFileTypes: true })) {
      const path = join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && !entry.isSymbolicLink()) {
        paths.push(relative(directory, path).split(sep).join("/"));
      } else {
        throw new Error(`Artifact installation contains a non-regular entry: ${relative(directory, path)}`);
      }
    }
  }

  await visit(directory);
  return paths.sort();
}

const binaryMetadata = await lstat(binaryPath).catch(() => null);
if (!binaryMetadata || binaryMetadata.isSymbolicLink() || !binaryMetadata.isFile()) {
  throw new Error(`Artifact binary must be an existing regular file: ${binaryPath}`);
}

const packageVersion = packageSchema.parse(parseJson(await Bun.file(packageJsonPath).text(), "package.json")).version;
if (packageVersion !== CLI_VERSION) {
  throw new Error(`package.json version ${packageVersion} does not match CLI version ${CLI_VERSION}`);
}

const packaged = embeddedIntegrationBundleSchema.parse(EMBEDDED_INTEGRATION_BUNDLE);
if (packaged.bundle_version !== packageVersion || packaged.bundle_version !== CLI_VERSION) {
  throw new Error("Generated integration bundle version does not match package and CLI versions");
}
if (packaged.agent_protocol_version !== AGENT_PROTOCOL_VERSION) {
  throw new Error("Generated integration bundle protocol does not match the CLI protocol version");
}

for (const expected of packaged.clients) {
  if (
    expected.schema !== packaged.schema ||
    expected.bundle_version !== packaged.bundle_version ||
    expected.agent_protocol_version !== packaged.agent_protocol_version
  ) {
    throw new Error(`Generated integration bundle metadata is inconsistent for ${expected.client}`);
  }
  for (const file of expected.files) {
    if (sha256(file.content) !== file.sha256) {
      throw new Error(`Generated integration bundle has an invalid content hash: ${expected.client}/${file.path}`);
    }
  }
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "asana-cli-package-content-"));

try {
  const binaryVersion = await runArtifact(["--version"], temporaryDirectory);
  if (binaryVersion !== `${CLI_VERSION}\n`) {
    throw new Error(`Artifact version ${JSON.stringify(binaryVersion)} does not exactly match CLI version ${CLI_VERSION}`);
  }

  const listed = integrationListingSchema.parse(
    parseJson(await runArtifact(["integrations", "list"], temporaryDirectory), "Artifact integrations list"),
  );
  if (
    listed.schema !== packaged.schema ||
    listed.bundle_version !== packaged.bundle_version ||
    listed.agent_protocol_version !== packaged.agent_protocol_version
  ) {
    throw new Error("Artifact does not expose the generated integration bundle metadata");
  }
  assertExactJson(listed.clients, INTEGRATION_CLIENTS, "Artifact integration client registry");

  for (const expected of packaged.clients) {
    const clientDirectory = join(temporaryDirectory, expected.client);
    await mkdir(clientDirectory, { recursive: true });
    await runArtifact([
      "integrations",
      "install",
      "--client",
      expected.client,
      "--scope",
      "project",
      "--apply",
    ], clientDirectory);

    const installationDirectory = join(clientDirectory, ...expected.install_roots.project.split("/"));
    const manifestPath = join(installationDirectory, INTEGRATION_MANIFEST_FILE);
    const manifest = integrationManifestSchema.parse(
      parseJson(await new TextDecoder("utf-8", { fatal: true }).decode(await readArtifactFile(manifestPath, `Manifest for ${expected.client}`)), `Manifest for ${expected.client}`),
    );
    if (
      manifest.schema !== INTEGRATION_MANIFEST_SCHEMA ||
      manifest.installer !== INTEGRATION_INSTALLER ||
      manifest.client !== expected.client ||
      manifest.scope !== "project" ||
      manifest.cli_version !== CLI_VERSION ||
      manifest.agent_protocol_version !== AGENT_PROTOCOL_VERSION ||
      manifest.agent_protocol_version !== expected.agent_protocol_version
    ) {
      throw new Error(`Artifact wrote incorrect manifest metadata for ${expected.client}`);
    }

    const expectedHashes = Object.fromEntries(expected.files.map((file) => [file.path, file.sha256]));
    if (Object.keys(expectedHashes).length !== expected.files.length) {
      throw new Error(`Generated integration bundle repeats an artifact path for ${expected.client}`);
    }
    assertExactHashMap(manifest.files, expectedHashes, `Manifest for ${expected.client}`);

    const actualPaths = await collectArtifactPaths(installationDirectory);
    const expectedPaths = [INTEGRATION_MANIFEST_FILE, ...expected.files.map((file) => file.path)].sort();
    assertExactJson(actualPaths, expectedPaths, `Artifact files for ${expected.client}`);

    for (const file of expected.files) {
      const content = await readArtifactFile(join(installationDirectory, ...file.path.split("/")), `${expected.client}/${file.path}`);
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(content);
      const digest = sha256(content);
      if (decoded !== file.content || digest !== file.sha256 || manifest.files[file.path] !== digest) {
        throw new Error(`Artifact does not contain the exact embedded bundle: ${expected.client}/${file.path}`);
      }
    }
  }

  process.stdout.write(`Artifact ${binaryPath} contains the exact embedded integration bundles\n`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
