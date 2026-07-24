import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { RELEASE_TARGETS } from "./check-support-matrix";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const safeReleaseFileSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/);

export const RELEASE_SIDECAR_SUFFIXES = Object.freeze([
  ".lifecycle.json",
  ".spdx.json",
  ".reproducibility.json",
  ".provenance.sigstore.json",
  ".sbom.sigstore.json",
] as const);

export const RELEASE_PAYLOAD_NAMES = Object.freeze([
  ...RELEASE_TARGETS.flatMap(({ output }) => [
    output,
    ...RELEASE_SIDECAR_SUFFIXES.map((suffix) => `${output}${suffix}`),
  ]),
  "asana-cli.rb",
].sort());

export const RELEASE_DISTRIBUTION_NAMES = Object.freeze([
  ...RELEASE_PAYLOAD_NAMES,
  "SHA256SUMS",
  "SHA256SUMS.sigstore.json",
].sort());

export type ReleaseChecksumEntry = Readonly<{
  name: string;
  sha256: string;
}>;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function buildReleaseChecksums(
  files: Readonly<Record<string, Uint8Array>>,
): string {
  const actual = Object.keys(files).sort();
  if (JSON.stringify(actual) !== JSON.stringify(RELEASE_PAYLOAD_NAMES)) {
    throw new Error("Release checksum input must contain the exact canonical payload set");
  }
  return RELEASE_PAYLOAD_NAMES
    .map((name) => `${sha256(files[name]!)}  ${name}`)
    .join("\n")
    .concat("\n");
}

export function parseReleaseChecksums(text: string): readonly ReleaseChecksumEntry[] {
  if (!text.endsWith("\n")) throw new Error("SHA256SUMS must end with one newline");
  const lines = text.slice(0, -1).split("\n");
  if (lines.some((line) => line.length === 0)) {
    throw new Error("SHA256SUMS contains an empty or trailing record");
  }
  const entries = lines.map((line) => {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9.-]*)$/.exec(line);
    if (!match) throw new Error("SHA256SUMS contains a malformed record");
    return {
      sha256: sha256Schema.parse(match[1]),
      name: safeReleaseFileSchema.parse(match[2]),
    };
  });
  const names = entries.map(({ name }) => name);
  if (new Set(names).size !== names.length) {
    throw new Error("SHA256SUMS repeats a release payload");
  }
  if (JSON.stringify(names) !== JSON.stringify(RELEASE_PAYLOAD_NAMES)) {
    throw new Error("SHA256SUMS must contain the canonical release payloads in order");
  }
  return entries;
}

export async function readReleasePayloads(
  directory: string,
): Promise<Readonly<Record<string, Uint8Array>>> {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.name !== "SHA256SUMS" && entry.name !== "SHA256SUMS.sigstore.json");
  const actualNames = entries.map((entry) => entry.name).sort();
  if (
    entries.some((entry) => !entry.isFile()) ||
    JSON.stringify(actualNames) !== JSON.stringify(RELEASE_PAYLOAD_NAMES)
  ) {
    throw new Error("Release directory must contain only the canonical regular payload files");
  }
  return Object.fromEntries(await Promise.all(RELEASE_PAYLOAD_NAMES.map(async (name) => [
    name,
    await readFile(join(directory, name)),
  ])));
}

export async function generateReleaseChecksums(
  directoryArgument: string,
  outputArgument: string,
): Promise<string> {
  const directory = resolve(directoryArgument);
  const output = resolve(outputArgument);
  if (resolve(directory, basename(output)) !== output || basename(output) !== "SHA256SUMS") {
    throw new Error("Release checksum output must be DIRECTORY/SHA256SUMS");
  }
  const text = buildReleaseChecksums(await readReleasePayloads(directory));
  await writeFile(output, text, { mode: 0o600 });
  return text;
}

export async function verifyReleaseChecksums(
  directoryArgument: string,
): Promise<readonly ReleaseChecksumEntry[]> {
  const directory = resolve(directoryArgument);
  const [files, text] = await Promise.all([
    readReleasePayloads(directory),
    readFile(join(directory, "SHA256SUMS"), "utf8"),
  ]);
  const entries = parseReleaseChecksums(text);
  const expected = buildReleaseChecksums(files);
  if (text !== expected) throw new Error("SHA256SUMS does not match the release payload bytes");
  return entries;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--output");
  const output = outputIndex === -1 ? undefined : args[outputIndex + 1];
  const positionals = outputIndex === -1
    ? args
    : args.filter((_, index) => index !== outputIndex && index !== outputIndex + 1);
  const [directory, ...unexpected] = positionals;
  if (
    !directory ||
    !output ||
    unexpected.length > 0 ||
    outputIndex + 2 !== args.length
  ) {
    throw new Error(
      "Usage: bun run scripts/release-assets.ts DIRECTORY --output DIRECTORY/SHA256SUMS",
    );
  }
  const text = await generateReleaseChecksums(directory, output);
  process.stdout.write(
    `Generated SHA256SUMS for ${parseReleaseChecksums(text).length} release payloads\n`,
  );
}
