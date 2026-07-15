import { z } from "zod";

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const gitObjectPattern = /^[0-9a-f]{40,64}$/i;

const releaseEnvironmentSchema = z.object({
  GITHUB_REF_NAME: z.string().min(1),
  GITHUB_SHA: z.string().regex(gitObjectPattern),
});

const packageSchema = z.looseObject({
  version: z.string().regex(semverPattern),
});

const gitCommitSchema = z.string().regex(gitObjectPattern);

export type ReleaseMetadata = {
  tag: string;
  eventObject: string;
  packageVersion: string;
};

export type GitResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type GitExecutor = (args: readonly string[]) => GitResult;

export function parseReleaseMetadata(
  environment: Record<string, string | undefined>,
  packageValue: unknown,
): ReleaseMetadata {
  const releaseEnvironment = releaseEnvironmentSchema.parse(environment);
  const packageJson = packageSchema.parse(packageValue);
  const expectedTag = `v${packageJson.version}`;

  if (releaseEnvironment.GITHUB_REF_NAME !== expectedTag) {
    throw new Error(
      `Release tag ${releaseEnvironment.GITHUB_REF_NAME} must exactly match package version ${expectedTag}`,
    );
  }

  return {
    tag: releaseEnvironment.GITHUB_REF_NAME,
    eventObject: releaseEnvironment.GITHUB_SHA,
    packageVersion: packageJson.version,
  };
}

function executeGit(args: readonly string[]): GitResult {
  const result = Bun.spawnSync(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const decoder = new TextDecoder();
  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout).trim(),
    stderr: decoder.decode(result.stderr).trim(),
  };
}

function requireGitCommit(runGit: GitExecutor, args: readonly string[], label: string): string {
  const result = runGit(args);
  if (result.exitCode !== 0) {
    throw new Error(`Unable to resolve ${label}: ${result.stderr || "git command failed"}`);
  }
  return gitCommitSchema.parse(result.stdout);
}

export function verifyReleaseCommit(
  metadata: ReleaseMetadata,
  runGit: GitExecutor = executeGit,
): string {
  const taggedCommit = requireGitCommit(
    runGit,
    ["rev-parse", "--verify", `${metadata.tag}^{commit}`],
    "tagged commit",
  );
  const eventCommit = requireGitCommit(
    runGit,
    ["rev-parse", "--verify", `${metadata.eventObject}^{commit}`],
    "release event commit",
  );
  const checkedOutCommit = requireGitCommit(
    runGit,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    "checked-out commit",
  );

  if (taggedCommit !== eventCommit || taggedCommit !== checkedOutCommit) {
    throw new Error("Release tag, event, and checked-out commit do not resolve to the same commit");
  }

  const ancestry = runGit(["merge-base", "--is-ancestor", taggedCommit, "origin/main"]);
  if (ancestry.exitCode === 1) {
    throw new Error(`Tagged commit ${taggedCommit} does not belong to origin/main`);
  }
  if (ancestry.exitCode !== 0) {
    throw new Error(`Unable to verify origin/main ancestry: ${ancestry.stderr || "git command failed"}`);
  }

  return taggedCommit;
}

async function main(): Promise<void> {
  const packageValue: unknown = await Bun.file("package.json").json();
  const metadata = parseReleaseMetadata(process.env, packageValue);
  const commit = verifyReleaseCommit(metadata);
  process.stdout.write(
    `Release preflight passed for ${metadata.tag} (${metadata.packageVersion}) at ${commit}\n`,
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown release preflight failure";
    process.stderr.write(`Release preflight failed: ${message}\n`);
    process.exit(1);
  }
}
