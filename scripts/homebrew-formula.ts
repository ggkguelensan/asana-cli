import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { RELEASE_TARGETS } from "./check-support-matrix";

const projectRoot = resolve(import.meta.dir, "..");
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const semverSchema = z.string().regex(
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
);
const tagSchema = z.string().regex(
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
);
const packageSchema = z.looseObject({
  version: semverSchema,
});
const baseUrlSchema = z.string().url().refine((value) => /^https:\/\//.test(value), {
  message: "Homebrew release base URL must use HTTPS",
});

const homebrewTargets = Object.freeze({
  darwinArm64: "asana-cli-darwin-arm64",
  darwinX64: "asana-cli-darwin-x64",
  linuxArm64: "asana-cli-linux-arm64",
  linuxX64: "asana-cli-linux-x64",
} as const);

for (const output of Object.values(homebrewTargets)) {
  if (!RELEASE_TARGETS.some((target) => target.output === output)) {
    throw new Error(`Homebrew target ${output} is outside the release matrix`);
  }
}

export type HomebrewFormulaInput = Readonly<{
  version: string;
  tag: string;
  baseUrl: string;
  checksums: Readonly<Record<string, string>>;
}>;

function formulaTargetBlock(
  platform: "macos" | "linux",
  architecture: "arm" | "intel",
  output: string,
  baseUrl: string,
  checksum: string,
): string {
  return [
    `  on_${platform} do`,
    `    on_${architecture} do`,
    `      url "${baseUrl}/${output}", using: :nounzip`,
    `      sha256 "${checksum}"`,
    "    end",
    "  end",
  ].join("\n");
}

export function buildHomebrewFormula(input: HomebrewFormulaInput): string {
  const version = semverSchema.parse(input.version);
  const tag = tagSchema.parse(input.tag);
  if (tag !== `v${version}`) throw new Error("Homebrew formula tag must match package version");
  const baseUrl = baseUrlSchema.parse(input.baseUrl).replace(/\/$/, "");
  const checksums = Object.fromEntries(
    Object.entries(input.checksums).map(([name, checksum]) => [
      name,
      sha256Schema.parse(checksum),
    ]),
  );
  const expectedNames = Object.values(homebrewTargets).sort();
  if (JSON.stringify(Object.keys(checksums).sort()) !== JSON.stringify(expectedNames)) {
    throw new Error("Homebrew formula requires exactly four supported glibc/macOS artifacts");
  }

  return [
    "class AsanaCli < Formula",
    '  desc "Safe single-binary CLI and agent protocol for Asana"',
    '  homepage "https://github.com/ggkguelensan/asana-cli"',
    `  version "${version}"`,
    '  license "MIT"',
    "",
    formulaTargetBlock(
      "macos",
      "arm",
      homebrewTargets.darwinArm64,
      baseUrl,
      checksums[homebrewTargets.darwinArm64]!,
    ),
    "",
    formulaTargetBlock(
      "macos",
      "intel",
      homebrewTargets.darwinX64,
      baseUrl,
      checksums[homebrewTargets.darwinX64]!,
    ),
    "",
    formulaTargetBlock(
      "linux",
      "arm",
      homebrewTargets.linuxArm64,
      baseUrl,
      checksums[homebrewTargets.linuxArm64]!,
    ),
    "",
    formulaTargetBlock(
      "linux",
      "intel",
      homebrewTargets.linuxX64,
      baseUrl,
      checksums[homebrewTargets.linuxX64]!,
    ),
    "",
    "  def install",
    "    artifact = if OS.mac?",
    `      Hardware::CPU.arm? ? "${homebrewTargets.darwinArm64}" : "${homebrewTargets.darwinX64}"`,
    "    else",
    `      Hardware::CPU.arm? ? "${homebrewTargets.linuxArm64}" : "${homebrewTargets.linuxX64}"`,
    "    end",
    '    bin.install artifact => "asana-cli"',
    "  end",
    "",
    "  test do",
    '    assert_equal version.to_s, shell_output("#{bin}/asana-cli --version").strip',
    "  end",
    "end",
    "",
  ].join("\n");
}

async function artifactChecksums(directory: string): Promise<Readonly<Record<string, string>>> {
  return Object.fromEntries(await Promise.all(
    Object.values(homebrewTargets).map(async (name) => [
      name,
      new Bun.CryptoHasher("sha256").update(await readFile(join(directory, name))).digest("hex"),
    ]),
  ));
}

export async function generateHomebrewFormula(
  directoryArgument: string,
  tagArgument: string,
  outputArgument: string,
  baseUrlArgument?: string,
): Promise<string> {
  const directory = resolve(directoryArgument);
  const output = resolve(outputArgument);
  if (resolve(directory, basename(output)) !== output || basename(output) !== "asana-cli.rb") {
    throw new Error("Homebrew formula output must be DIRECTORY/asana-cli.rb");
  }
  const packageValue = packageSchema.parse(
    await Bun.file(resolve(projectRoot, "package.json")).json() as unknown,
  );
  const tag = tagSchema.parse(tagArgument);
  const baseUrl = baseUrlArgument ??
    `https://github.com/ggkguelensan/asana-cli/releases/download/${tag}`;
  const formula = buildHomebrewFormula({
    version: packageValue.version,
    tag,
    baseUrl,
    checksums: await artifactChecksums(directory),
  });
  await writeFile(output, formula, { mode: 0o600 });
  return formula;
}

export async function verifyHomebrewFormula(
  directoryArgument: string,
  tagArgument: string,
  baseUrlArgument?: string,
): Promise<void> {
  const directory = resolve(directoryArgument);
  const packageValue = packageSchema.parse(
    await Bun.file(resolve(projectRoot, "package.json")).json() as unknown,
  );
  const tag = tagSchema.parse(tagArgument);
  const expected = buildHomebrewFormula({
    version: packageValue.version,
    tag,
    baseUrl: baseUrlArgument ??
      `https://github.com/ggkguelensan/asana-cli/releases/download/${tag}`,
    checksums: await artifactChecksums(directory),
  });
  const actual = await readFile(join(directory, "asana-cli.rb"), "utf8");
  if (actual !== expected) {
    throw new Error("Homebrew formula does not match the release artifact checksums");
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--output");
  const baseUrlIndex = args.indexOf("--base-url");
  const excluded = new Set([
    outputIndex,
    outputIndex + 1,
    ...(baseUrlIndex === -1 ? [] : [baseUrlIndex, baseUrlIndex + 1]),
  ]);
  const positionals = args.filter((_, index) => !excluded.has(index));
  const [directory, tag, ...unexpected] = positionals;
  const output = outputIndex === -1 ? undefined : args[outputIndex + 1];
  const baseUrl = baseUrlIndex === -1 ? undefined : args[baseUrlIndex + 1];
  if (
    !directory ||
    !tag ||
    !output ||
    unexpected.length > 0 ||
    outputIndex + 2 > args.length ||
    (baseUrlIndex !== -1 && !baseUrl)
  ) {
    throw new Error(
      "Usage: bun run scripts/homebrew-formula.ts DIRECTORY TAG --output DIRECTORY/asana-cli.rb [--base-url HTTPS_URL]",
    );
  }
  const formula = await generateHomebrewFormula(directory, tag, output, baseUrl);
  process.stdout.write(`Generated Homebrew formula (${formula.length} bytes)\n`);
}
