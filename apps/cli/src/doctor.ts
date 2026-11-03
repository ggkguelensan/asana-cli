import { realpath } from "node:fs/promises";
import { z } from "zod";
import { booleanFlag, type ParsedArgs } from "./args";
import { getMe } from "./asana-commands";
import { CliError, normalizeError } from "./errors";
import { probeInvocationLog } from "./invocation-log";
import {
  resolvePatWithSource,
  type PatSource,
} from "./pat-store";
import { registerSecret } from "./security";
import {
  compareSemver,
  defaultUpdateCommandDependencies,
  type Installation,
  type LatestRelease,
  type ReleaseTarget,
} from "./self-update";
import { createClient } from "./sdk";
import { CLI_VERSION } from "./version";

const doctorEnvironmentSchema = z.object({
  ASANA_ACCESS_TOKEN: z.string().optional(),
  ASANA_PAT: z.string().optional(),
});

export type DoctorCheck = Readonly<{
  id: string;
  status: "ok" | "warning" | "error" | "skipped";
  message: string;
  details?: Readonly<Record<string, unknown>>;
}>;

export type CredentialProbe = Readonly<{
  configured: boolean;
  source: PatSource | null;
  verified: boolean;
  status: "ok" | "warning" | "error" | "skipped";
  message: string;
}>;

export type DoctorDependencies = Readonly<{
  resolveTarget: () => Promise<ReleaseTarget>;
  detectInstallation: () => Promise<Installation>;
  findOnPath: () => string | null;
  probeLog: () => Promise<Readonly<{ path: string; ready: true }>>;
  probeCredential: (offline: boolean) => Promise<CredentialProbe>;
  fetchLatestRelease: (target: ReleaseTarget) => Promise<LatestRelease>;
}>;

async function defaultCredentialProbe(offline: boolean): Promise<CredentialProbe> {
  const environment = doctorEnvironmentSchema.parse(process.env);
  let resolved: Awaited<ReturnType<typeof resolvePatWithSource>>;
  try {
    resolved = await resolvePatWithSource();
  } catch (error) {
    const normalized = normalizeError(error);
    if (normalized.code === "auth-required") {
      return {
        configured: false,
        source: null,
        verified: false,
        status: "warning",
        message: "No Asana PAT is configured",
      };
    }
    return {
      configured: Boolean(environment.ASANA_ACCESS_TOKEN || environment.ASANA_PAT),
      source: environment.ASANA_ACCESS_TOKEN
        ? "ASANA_ACCESS_TOKEN"
        : environment.ASANA_PAT
          ? "ASANA_PAT"
          : null,
      verified: false,
      status: "error",
      message: "Credential storage is unavailable or contains invalid data",
    };
  }
  registerSecret(resolved.pat);
  if (offline) {
    return {
      configured: true,
      source: resolved.source,
      verified: false,
      status: "skipped",
      message: "Credential is configured; validation was skipped in offline mode",
    };
  }
  try {
    await getMe(createClient(resolved.pat), "gid");
    return {
      configured: true,
      source: resolved.source,
      verified: true,
      status: "ok",
      message: "Asana authentication succeeded",
    };
  } catch (error) {
    const normalized = normalizeError(error, resolved.pat);
    const network = normalized.code === "network";
    return {
      configured: true,
      source: resolved.source,
      verified: false,
      status: network ? "warning" : "error",
      message: network
        ? "Asana authentication could not be checked because the network is unavailable"
        : "Asana rejected the configured credential",
    };
  }
}

export const defaultDoctorDependencies: DoctorDependencies = {
  resolveTarget: defaultUpdateCommandDependencies.resolveTarget,
  detectInstallation: defaultUpdateCommandDependencies.detectInstallation,
  findOnPath: () => Bun.which("asana-cli"),
  probeLog: () => probeInvocationLog(),
  probeCredential: defaultCredentialProbe,
  fetchLatestRelease: defaultUpdateCommandDependencies.fetchLatestRelease,
};

function requireDoctorArguments(args: ParsedArgs): Readonly<{ offline: boolean }> {
  if (args.positionals.length !== 1) {
    throw new CliError("usage", "Usage: asana-cli doctor [--offline]");
  }
  const allowed = new Set(["offline", "compact"]);
  for (const [name, value] of Object.entries(args.flags)) {
    if (!allowed.has(name)) {
      throw new CliError("usage", `Unsupported option for doctor: --${name}`);
    }
    if (Array.isArray(value)) {
      throw new CliError("usage", `--${name} may be provided only once`);
    }
  }
  return { offline: booleanFlag(args, "offline") };
}

async function sameFile(left: string, right: string): Promise<boolean> {
  try {
    const [resolvedLeft, resolvedRight] = await Promise.all([
      realpath(left),
      realpath(right),
    ]);
    return resolvedLeft === resolvedRight;
  } catch {
    return false;
  }
}

function summaryStatus(checks: readonly DoctorCheck[]): "ok" | "warning" | "error" {
  if (checks.some(({ status }) => status === "error")) return "error";
  if (checks.some(({ status }) => status === "warning")) return "warning";
  return "ok";
}

export async function runDoctorCommand(
  args: ParsedArgs,
  dependencies: DoctorDependencies = defaultDoctorDependencies,
): Promise<unknown> {
  const { offline } = requireDoctorArguments(args);
  const checks: DoctorCheck[] = [];
  const suggestions: string[] = [];

  let target: ReleaseTarget | undefined;
  try {
    target = await dependencies.resolveTarget();
    checks.push({
      id: "runtime",
      status: "ok",
      message: "Runtime has a supported release target",
      details: {
        platform: target.platform,
        architecture: target.architecture,
        libc: target.libc,
        artifact: target.artifact,
      },
    });
  } catch {
    checks.push({
      id: "runtime",
      status: "error",
      message: "Runtime does not have a supported release target",
    });
  }

  let installation: Installation | undefined;
  try {
    installation = await dependencies.detectInstallation();
    checks.push({
      id: "installation",
      status: installation.kind === "standalone" ? "ok" : "warning",
      message: installation.kind === "standalone"
        ? "Standalone executable can use atomic self-update"
        : `Installation is managed by ${installation.kind}`,
      details: {
        kind: installation.kind,
        executable: installation.executable,
      },
    });
  } catch {
    checks.push({
      id: "installation",
      status: "error",
      message: "Current executable installation could not be resolved safely",
    });
  }

  const onPath = dependencies.findOnPath();
  if (!onPath) {
    checks.push({
      id: "path",
      status: "warning",
      message: "asana-cli is not discoverable through PATH",
    });
    suggestions.push('Add the installation directory to PATH, then run "asana-cli doctor" again');
  } else {
    const matches = installation?.kind === "bun" ||
      installation === undefined ||
      await sameFile(onPath, installation.executable);
    checks.push({
      id: "path",
      status: matches ? "ok" : "warning",
      message: matches
        ? "PATH resolves an asana-cli executable"
        : "PATH resolves a different asana-cli executable",
      details: { resolved: onPath },
    });
    if (!matches) suggestions.push("Remove the stale asana-cli entry earlier in PATH");
  }

  try {
    const log = await dependencies.probeLog();
    checks.push({
      id: "invocation-log",
      status: "ok",
      message: "Local metadata-only invocation log is writable",
      details: {
        path: log.path,
        content_policy: "no credentials, task content, comments, or free-form argument values",
      },
    });
  } catch {
    checks.push({
      id: "invocation-log",
      status: "error",
      message: "Local invocation log is unavailable or unsafe",
    });
    suggestions.push("Check HOME/XDG_STATE_HOME ownership and permissions");
  }

  const credential = await dependencies.probeCredential(offline);
  checks.push({
    id: "authentication",
    status: credential.status,
    message: credential.message,
    details: {
      configured: credential.configured,
      source: credential.source,
      verified: credential.verified,
    },
  });
  if (!credential.configured) suggestions.push("Run `asana-cli auth pat set`");
  if (credential.status === "error") {
    suggestions.push("Reset or revoke the PAT in Asana Developer Console, then configure it again");
  }

  if (offline) {
    checks.push({
      id: "release",
      status: "skipped",
      message: "GitHub release check was skipped in offline mode",
    });
  } else if (target) {
    try {
      const release = await dependencies.fetchLatestRelease(target);
      const comparison = compareSemver(release.version, CLI_VERSION);
      checks.push({
        id: "release",
        status: comparison > 0 ? "warning" : "ok",
        message: comparison > 0
          ? `A newer asana-cli release is available: ${release.version}`
          : comparison < 0
            ? "This development build is newer than the latest release"
            : "asana-cli is up to date",
        details: {
          current_version: CLI_VERSION,
          latest_version: release.version,
          release_url: release.url,
        },
      });
      if (comparison > 0) suggestions.push("Run `asana-cli update`");
    } catch {
      checks.push({
        id: "release",
        status: "warning",
        message: "Latest GitHub release could not be checked",
      });
    }
  }

  const status = summaryStatus(checks);
  return {
    schema: "asana-cli.doctor.v1",
    cli_version: CLI_VERSION,
    status,
    offline,
    summary: {
      ok: checks.filter((check) => check.status === "ok").length,
      warnings: checks.filter((check) => check.status === "warning").length,
      errors: checks.filter((check) => check.status === "error").length,
      skipped: checks.filter((check) => check.status === "skipped").length,
    },
    checks,
    suggestions: [...new Set(suggestions)],
  };
}
