import { createHash } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  RELEASE_TARGETS,
  supportedBuildTargetSchema,
  type SupportedBuildTarget,
} from "./check-support-matrix";

const projectRoot = resolve(import.meta.dir, "..");
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const sha512Schema = z.string().regex(/^[a-f0-9]{128}$/);
const gitCommitSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
const sourceDateEpochSchema = z.coerce.number().int().nonnegative();
const semverSchema = z.string().regex(
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
);
const dependencyMapSchema = z.record(z.string(), z.string());
const lockPackageMetadataSchema = z.looseObject({
  dependencies: dependencyMapSchema.optional(),
  optionalDependencies: dependencyMapSchema.optional(),
});
const lockPackageSchema = z.tuple([
  z.string().min(3),
  z.string(),
  lockPackageMetadataSchema,
  z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/),
]);
const bunLockSchema = z.strictObject({
  lockfileVersion: z.number().int().positive(),
  configVersion: z.number().int().positive(),
  workspaces: z.record(z.string(), z.looseObject({
    name: z.string().min(1),
    dependencies: dependencyMapSchema.optional(),
  })),
  packages: z.record(z.string(), lockPackageSchema),
});
const packageSchema = z.looseObject({
  name: z.literal("asana-cli"),
  version: semverSchema,
  packageManager: z.string().regex(/^bun@\d+\.\d+\.\d+$/),
  dependencies: dependencyMapSchema,
});
const checksumSchema = z.strictObject({
  algorithm: z.enum(["SHA256", "SHA512"]),
  checksumValue: z.union([sha256Schema, sha512Schema]),
});
const externalRefSchema = z.strictObject({
  referenceCategory: z.literal("PACKAGE-MANAGER"),
  referenceType: z.literal("purl"),
  referenceLocator: z.string().startsWith("pkg:"),
});
const spdxPackageSchema = z.strictObject({
  name: z.string().min(1),
  SPDXID: z.string().regex(/^SPDXRef-[A-Za-z0-9.-]+$/),
  versionInfo: z.string().min(1),
  downloadLocation: z.string().min(1),
  filesAnalyzed: z.literal(false),
  licenseConcluded: z.string().min(1),
  licenseDeclared: z.string().min(1),
  copyrightText: z.string().min(1),
  primaryPackagePurpose: z.enum(["APPLICATION", "LIBRARY"]),
  checksums: z.array(checksumSchema).max(1),
  externalRefs: z.array(externalRefSchema).length(1),
});
const spdxFileSchema = z.strictObject({
  fileName: z.string().regex(/^\.\/asana-cli-(?:darwin|linux)-[a-z0-9-]+$/),
  SPDXID: z.literal("SPDXRef-File-Binary"),
  checksums: z.array(checksumSchema).length(1),
  licenseConcluded: z.literal("NOASSERTION"),
  copyrightText: z.literal("NOASSERTION"),
  fileTypes: z.tuple([z.literal("BINARY")]),
});
const relationshipSchema = z.strictObject({
  spdxElementId: z.string().regex(/^SPDXRef-[A-Za-z0-9.-]+$/),
  relationshipType: z.enum(["CONTAINS", "DEPENDS_ON", "DESCRIBES"]),
  relatedSpdxElement: z.string().regex(/^SPDXRef-[A-Za-z0-9.-]+$/),
});

export const releaseSbomSchema = z.strictObject({
  spdxVersion: z.literal("SPDX-2.3"),
  dataLicense: z.literal("CC0-1.0"),
  SPDXID: z.literal("SPDXRef-DOCUMENT"),
  name: z.string().min(1),
  documentNamespace: z.string().url(),
  documentDescribes: z.tuple([z.literal("SPDXRef-Package-asana-cli")]),
  creationInfo: z.strictObject({
    created: z.iso.datetime({ offset: false }),
    creators: z.tuple([z.literal("Tool: asana-cli-release-sbom/1")]),
  }),
  documentComment: z.string().min(1),
  packages: z.array(spdxPackageSchema).min(3),
  files: z.tuple([spdxFileSchema]),
  relationships: z.array(relationshipSchema).min(4),
});

export type ReleaseSbom = z.output<typeof releaseSbomSchema>;
type LockPackage = z.output<typeof lockPackageSchema>;

export type ReleaseSbomInput = Readonly<{
  binaryName: string;
  binaryBytes: Uint8Array;
  target: SupportedBuildTarget;
  sourceCommit: string;
  sourceDateEpoch: number | string;
  lockText: string;
  packageValue: unknown;
}>;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function packageIdentity(tuple: LockPackage): Readonly<{ name: string; version: string }> {
  const identity = tuple[0];
  const delimiter = identity.lastIndexOf("@");
  if (delimiter <= 0 || delimiter === identity.length - 1) {
    throw new Error(`Invalid locked package identity: ${identity}`);
  }
  return {
    name: identity.slice(0, delimiter),
    version: identity.slice(delimiter + 1),
  };
}

function packageSpdxId(name: string, version: string): string {
  return `SPDXRef-Package-${sha256(`${name}@${version}`).slice(0, 24)}`;
}

function npmPurl(name: string, version: string): string {
  const encodedName = encodeURIComponent(name).replaceAll("%2F", "/");
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function sha512IntegrityHex(integrity: string): string {
  const bytes = Buffer.from(integrity.slice("sha512-".length), "base64");
  return sha512Schema.parse(bytes.toString("hex"));
}

function targetOutput(target: SupportedBuildTarget): string {
  const releaseTarget = RELEASE_TARGETS.find((candidate) => candidate.target === target);
  if (!releaseTarget) throw new Error(`Missing release output for ${target}`);
  return releaseTarget.output;
}

function dependencyNames(tuple: LockPackage): readonly string[] {
  return [...new Set([
    ...Object.keys(tuple[2].dependencies ?? {}),
    ...Object.keys(tuple[2].optionalDependencies ?? {}),
  ])].sort();
}

function productionClosure(
  directDependencies: Readonly<Record<string, string>>,
  packages: Readonly<Record<string, LockPackage>>,
): readonly string[] {
  const pending = Object.keys(directDependencies).sort();
  const visited = new Set<string>();
  while (pending.length > 0) {
    const name = pending.shift();
    if (name === undefined || visited.has(name)) continue;
    const tuple = packages[name];
    if (!tuple) throw new Error(`Production dependency ${name} is absent from bun.lock`);
    visited.add(name);
    for (const dependency of dependencyNames(tuple)) {
      if (packages[dependency] && !visited.has(dependency)) pending.push(dependency);
    }
    pending.sort();
  }
  return [...visited].sort();
}

function stableRelationships(
  relationships: readonly z.output<typeof relationshipSchema>[],
): readonly z.output<typeof relationshipSchema>[] {
  return [...relationships].sort((left, right) =>
    `${left.spdxElementId}:${left.relationshipType}:${left.relatedSpdxElement}`.localeCompare(
      `${right.spdxElementId}:${right.relationshipType}:${right.relatedSpdxElement}`,
    )
  );
}

export function buildReleaseSbom(input: ReleaseSbomInput): ReleaseSbom {
  const target = supportedBuildTargetSchema.parse(input.target);
  const expectedBinaryName = targetOutput(target);
  if (input.binaryName !== expectedBinaryName) {
    throw new Error(`${target} SBOM must describe ${expectedBinaryName}`);
  }
  const sourceCommit = gitCommitSchema.parse(input.sourceCommit);
  const sourceDateEpoch = sourceDateEpochSchema.parse(input.sourceDateEpoch);
  const packageJson = packageSchema.parse(input.packageValue);
  const lock = bunLockSchema.parse(Bun.JSONC.parse(input.lockText) as unknown);
  const rootWorkspace = lock.workspaces[""];
  if (!rootWorkspace || rootWorkspace.name !== packageJson.name) {
    throw new Error("bun.lock root workspace does not match package.json");
  }
  if (
    JSON.stringify(rootWorkspace.dependencies ?? {}) !==
      JSON.stringify(packageJson.dependencies)
  ) {
    throw new Error("package.json production dependencies do not match bun.lock");
  }

  const binarySha256 = sha256(input.binaryBytes);
  const lockSha256 = sha256(input.lockText);
  const bunVersion = packageJson.packageManager.slice("bun@".length);
  const dependencyKeys = productionClosure(packageJson.dependencies, lock.packages);
  const packageIds = new Map<string, string>();
  const dependencyPackages = dependencyKeys.map((key) => {
    const tuple = lock.packages[key];
    if (!tuple) throw new Error(`Missing locked package ${key}`);
    const identity = packageIdentity(tuple);
    const spdxId = packageSpdxId(identity.name, identity.version);
    packageIds.set(key, spdxId);
    return {
      name: identity.name,
      SPDXID: spdxId,
      versionInfo: identity.version,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false as const,
      licenseConcluded: "NOASSERTION",
      licenseDeclared: "NOASSERTION",
      copyrightText: "NOASSERTION",
      primaryPackagePurpose: "LIBRARY" as const,
      checksums: [{
        algorithm: "SHA512" as const,
        checksumValue: sha512IntegrityHex(tuple[3]),
      }],
      externalRefs: [{
        referenceCategory: "PACKAGE-MANAGER" as const,
        referenceType: "purl" as const,
        referenceLocator: npmPurl(identity.name, identity.version),
      }],
    };
  });

  const binaryUrl =
    `https://github.com/ggkguelensan/asana-cli/releases/download/v${packageJson.version}/${input.binaryName}`;
  const rootPackage = {
    name: packageJson.name,
    SPDXID: "SPDXRef-Package-asana-cli",
    versionInfo: packageJson.version,
    downloadLocation: binaryUrl,
    filesAnalyzed: false as const,
    licenseConcluded: "MIT",
    licenseDeclared: "MIT",
    copyrightText: "NOASSERTION",
    primaryPackagePurpose: "APPLICATION" as const,
    checksums: [{ algorithm: "SHA256" as const, checksumValue: binarySha256 }],
    externalRefs: [{
      referenceCategory: "PACKAGE-MANAGER" as const,
      referenceType: "purl" as const,
      referenceLocator:
        `pkg:github/ggkguelensan/asana-cli@${encodeURIComponent(packageJson.version)}`,
    }],
  };
  const bunPackageId = `SPDXRef-Package-Bun-${bunVersion.replaceAll(".", "-")}`;
  const bunPackage = {
    name: "Bun",
    SPDXID: bunPackageId,
    versionInfo: bunVersion,
    downloadLocation: "https://bun.sh",
    filesAnalyzed: false as const,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: "NOASSERTION",
    copyrightText: "NOASSERTION",
    primaryPackagePurpose: "LIBRARY" as const,
    checksums: [],
    externalRefs: [{
      referenceCategory: "PACKAGE-MANAGER" as const,
      referenceType: "purl" as const,
      referenceLocator: `pkg:generic/bun@${bunVersion}`,
    }],
  };

  const relationships: z.output<typeof relationshipSchema>[] = [
    {
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: rootPackage.SPDXID,
    },
    {
      spdxElementId: rootPackage.SPDXID,
      relationshipType: "CONTAINS",
      relatedSpdxElement: "SPDXRef-File-Binary",
    },
    {
      spdxElementId: rootPackage.SPDXID,
      relationshipType: "CONTAINS",
      relatedSpdxElement: bunPackageId,
    },
  ];
  for (const key of dependencyKeys) {
    const packageId = packageIds.get(key);
    if (!packageId) throw new Error(`Missing SPDX ID for ${key}`);
    relationships.push({
      spdxElementId: rootPackage.SPDXID,
      relationshipType: "CONTAINS",
      relatedSpdxElement: packageId,
    });
    const tuple = lock.packages[key];
    if (!tuple) throw new Error(`Missing locked package ${key}`);
    for (const dependency of dependencyNames(tuple)) {
      const dependencyId = packageIds.get(dependency);
      if (!dependencyId) continue;
      relationships.push({
        spdxElementId: packageId,
        relationshipType: "DEPENDS_ON",
        relatedSpdxElement: dependencyId,
      });
    }
  }

  return releaseSbomSchema.parse({
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${packageJson.name}-${packageJson.version}-${target}`,
    documentNamespace:
      `https://github.com/ggkguelensan/asana-cli/sbom/${sourceCommit}/${target}/${binarySha256}`,
    documentDescribes: ["SPDXRef-Package-asana-cli"],
    creationInfo: {
      created: new Date(sourceDateEpoch * 1000).toISOString(),
      creators: ["Tool: asana-cli-release-sbom/1"],
    },
    documentComment:
      `source_commit=${sourceCommit}; target=${target}; bun_lock_sha256=${lockSha256}; binary_sha256=${binarySha256}`,
    packages: [rootPackage, bunPackage, ...dependencyPackages],
    files: [{
      fileName: `./${input.binaryName}`,
      SPDXID: "SPDXRef-File-Binary",
      checksums: [{ algorithm: "SHA256", checksumValue: binarySha256 }],
      licenseConcluded: "NOASSERTION",
      copyrightText: "NOASSERTION",
      fileTypes: ["BINARY"],
    }],
    relationships: stableRelationships(relationships),
  });
}

export async function generateReleaseSbom(
  binaryPath: string,
  target: SupportedBuildTarget,
  sourceCommit: string,
  sourceDateEpoch: number | string,
  outputPath: string,
): Promise<ReleaseSbom> {
  const [binaryBytes, lockText, packageValue] = await Promise.all([
    readFile(binaryPath),
    readFile(resolve(projectRoot, "bun.lock"), "utf8"),
    Bun.file(resolve(projectRoot, "package.json")).json() as Promise<unknown>,
  ]);
  const sbom = buildReleaseSbom({
    binaryName: basename(binaryPath),
    binaryBytes,
    target,
    sourceCommit,
    sourceDateEpoch,
    lockText,
    packageValue,
  });
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, `${JSON.stringify(sbom, null, 2)}\n`, { mode: 0o600 });
  return sbom;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--output");
  const output = outputIndex === -1 ? undefined : args[outputIndex + 1];
  const positionals = outputIndex === -1
    ? args
    : args.filter((_, index) => index !== outputIndex && index !== outputIndex + 1);
  const [binary, rawTarget, sourceCommit, sourceDateEpoch, ...unexpected] = positionals;
  if (
    !binary ||
    !rawTarget ||
    !sourceCommit ||
    !sourceDateEpoch ||
    !output ||
    unexpected.length > 0 ||
    outputIndex + 2 !== args.length
  ) {
    throw new Error(
      "Usage: bun run scripts/release-sbom.ts BINARY TARGET SOURCE_COMMIT SOURCE_DATE_EPOCH --output FILE",
    );
  }
  const target = supportedBuildTargetSchema.parse(rawTarget);
  const sbom = await generateReleaseSbom(
    resolve(binary),
    target,
    sourceCommit,
    sourceDateEpoch,
    resolve(output),
  );
  process.stdout.write(
    `Generated SPDX 2.3 SBOM for ${target}: ${sbom.packages.length} packages\n`,
  );
}
