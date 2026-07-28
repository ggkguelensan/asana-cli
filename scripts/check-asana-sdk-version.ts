import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const ASANA_SDK_PACKAGE = "asana" as const;
export const ASANA_SDK_REGISTRY_URL =
  "https://registry.npmjs.org/asana" as const;
export const DEPENDENCY_QUARANTINE_DAYS = 14 as const;
const DAY_MS = 24 * 60 * 60 * 1_000;
const WEEK_MS = 7 * DAY_MS;
const BIWEEKLY_ANCHOR_MS = Date.UTC(2026, 7, 3);
const stableSemverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const projectRoot = resolve(import.meta.dir, "..");

type StableSemver = Readonly<{
  value: string;
  parts: readonly [number, number, number];
}>;

export type AsanaSdkVersionResult = Readonly<{
  package: typeof ASANA_SDK_PACKAGE;
  pinnedVersion: string;
  latestVersion: string;
  latestPublishedAt: string;
  quarantineEligibleVersion: string;
  quarantineEligiblePublishedAt: string;
  quarantineDays: typeof DEPENDENCY_QUARANTINE_DAYS;
  latestInQuarantine: boolean;
  latestQuarantineEndsAt: string;
  behind: boolean;
}>;

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stableSemver(value: unknown, label: string): StableSemver {
  if (typeof value !== "string") {
    throw new Error(`${label} must be an exact stable semantic version`);
  }
  const match = stableSemverPattern.exec(value);
  if (!match) {
    throw new Error(`${label} must be an exact stable semantic version`);
  }
  return {
    value,
    parts: [
      Number.parseInt(match[1]!, 10),
      Number.parseInt(match[2]!, 10),
      Number.parseInt(match[3]!, 10),
    ],
  };
}

function compareSemver(left: StableSemver, right: StableSemver): number {
  for (let index = 0; index < left.parts.length; index += 1) {
    const difference = left.parts[index]! - right.parts[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function publishedAt(
  time: Readonly<Record<string, unknown>>,
  version: string,
): Date {
  const value = time[version];
  if (typeof value !== "string") {
    throw new Error(`npm registry metadata has no publication time for ${version}`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`npm registry metadata has an invalid publication time for ${version}`);
  }
  return date;
}

export function isBiweeklyAsanaSdkCheckDue(now: Date): boolean {
  const elapsed = now.getTime() - BIWEEKLY_ANCHOR_MS;
  if (!Number.isFinite(elapsed) || elapsed < 0) return false;
  return Math.floor(elapsed / WEEK_MS) % 2 === 0;
}

export function evaluateAsanaSdkVersion(
  packageValue: unknown,
  registryValue: unknown,
  now: Date,
): AsanaSdkVersionResult {
  if (!Number.isFinite(now.getTime())) throw new Error("Current time is invalid");
  const packageManifest = objectRecord(packageValue, "package.json");
  const dependencies = objectRecord(
    packageManifest.dependencies,
    "package.json dependencies",
  );
  const pinned = stableSemver(
    dependencies[ASANA_SDK_PACKAGE],
    "package.json asana dependency",
  );

  const registry = objectRecord(registryValue, "npm registry metadata");
  const distTags = objectRecord(registry["dist-tags"], "npm registry dist-tags");
  const versions = objectRecord(registry.versions, "npm registry versions");
  const time = objectRecord(registry.time, "npm registry publication times");
  const latest = stableSemver(distTags.latest, "npm registry latest tag");
  if (!(latest.value in versions)) {
    throw new Error(`npm registry latest version ${latest.value} has no manifest`);
  }
  if (!(pinned.value in versions)) {
    throw new Error(`Pinned Asana SDK ${pinned.value} is absent from npm registry metadata`);
  }

  const quarantineCutoffMs =
    now.getTime() - DEPENDENCY_QUARANTINE_DAYS * DAY_MS;
  const eligible = Object.keys(versions)
    .flatMap((version) => {
      if (!stableSemverPattern.test(version)) return [];
      const candidate = stableSemver(version, "npm registry version");
      if (compareSemver(candidate, latest) > 0) return [];
      const publication = publishedAt(time, version);
      return publication.getTime() <= quarantineCutoffMs
        ? [{ version: candidate, publication }]
        : [];
    })
    .sort((left, right) => compareSemver(right.version, left.version))[0];
  if (!eligible) {
    throw new Error("npm registry has no Asana SDK release outside quarantine");
  }

  const latestPublication = publishedAt(time, latest.value);
  return {
    package: ASANA_SDK_PACKAGE,
    pinnedVersion: pinned.value,
    latestVersion: latest.value,
    latestPublishedAt: latestPublication.toISOString(),
    quarantineEligibleVersion: eligible.version.value,
    quarantineEligiblePublishedAt: eligible.publication.toISOString(),
    quarantineDays: DEPENDENCY_QUARANTINE_DAYS,
    latestInQuarantine: latestPublication.getTime() > quarantineCutoffMs,
    latestQuarantineEndsAt: new Date(
      latestPublication.getTime() + DEPENDENCY_QUARANTINE_DAYS * DAY_MS,
    ).toISOString(),
    behind: compareSemver(pinned, eligible.version) < 0,
  };
}

function renderResult(result: AsanaSdkVersionResult): string {
  const status = result.behind ? "OUTDATED" : "CURRENT";
  const lines = [
    `Asana Node SDK: ${status}`,
    `Pinned: ${result.pinnedVersion}`,
    `Latest quarantine-eligible: ${result.quarantineEligibleVersion}`,
    `Registry latest: ${result.latestVersion} (${result.latestPublishedAt})`,
  ];
  if (result.latestInQuarantine) {
    lines.push(
      `Registry latest remains quarantined until ${result.latestQuarantineEndsAt}`,
    );
  }
  if (result.behind) {
    lines.push(
      `Update with: bun add --exact asana@${result.quarantineEligibleVersion}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

async function registryMetadata(): Promise<unknown> {
  const response = await fetch(ASANA_SDK_REGISTRY_URL, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`npm registry returned HTTP ${response.status}`);
  }
  return response.json() as Promise<unknown>;
}

async function main(arguments_: readonly string[]): Promise<void> {
  const scheduled = arguments_.length === 1 && arguments_[0] === "--scheduled";
  if (arguments_.length > (scheduled ? 1 : 0)) {
    throw new Error(
      "Usage: bun run check:asana-sdk-version [--scheduled]",
    );
  }
  const now = new Date();
  if (scheduled && !isBiweeklyAsanaSdkCheckDue(now)) {
    process.stdout.write("Asana Node SDK check: skipped on the alternate week\n");
    return;
  }
  const [packageText, registry] = await Promise.all([
    readFile(resolve(projectRoot, "package.json"), "utf8"),
    registryMetadata(),
  ]);
  const result = evaluateAsanaSdkVersion(
    JSON.parse(packageText) as unknown,
    registry,
    now,
  );
  process.stdout.write(renderResult(result));
  if (result.behind) process.exitCode = 1;
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
