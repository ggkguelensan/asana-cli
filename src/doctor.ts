import { z } from "zod";
import { booleanFlag, type ParsedArgs } from "./args";
import { getMe } from "./asana-commands";
import { CliError, normalizeError } from "./errors";
import { resolvePatWithSource, type PatSource } from "./pat-store";
import { registerSecret } from "./security";
import { createClient } from "./sdk";
import { assertSupportedRuntimePlatform } from "./platform-support";
import { CLI_VERSION } from "./version";

const doctorEnvironmentSchema = z.object({
  ASANA_ACCESS_TOKEN: z.string().optional(), ASANA_PAT: z.string().optional(),
});

export type CredentialProbe = Readonly<{
  configured: boolean;
  source: PatSource | null;
  verified: boolean;
  status: "ok" | "warning" | "error" | "skipped";
  message: string;
}>;
export type DoctorDependencies = Readonly<{
  findOnPath: () => string | null;
  probeCredential: (offline: boolean) => Promise<CredentialProbe>;
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

export async function runDoctorCommand(
  args: ParsedArgs,
  dependencies: DoctorDependencies = {
    findOnPath: () => Bun.which("asana-cli"),
    probeCredential: defaultCredentialProbe,
  },
): Promise<unknown> {
  if (args.positionals.length !== 1) throw new CliError("usage", "Usage: asana-cli doctor [--offline]");
  for (const [name, value] of Object.entries(args.flags)) {
    if (!["offline", "compact"].includes(name) || Array.isArray(value)) {
      throw new CliError("usage", `Unsupported option for doctor: --${name}`);
    }
  }
  const offline = booleanFlag(args, "offline");
  const platform = assertSupportedRuntimePlatform();
  const executable = dependencies.findOnPath();
  const credential = await dependencies.probeCredential(offline);
  const checks = [
    { id: "runtime", status: "ok", message: "Supported runtime", details: { platform, architecture: process.arch } },
    { id: "path", status: executable ? "ok" : "warning", message: executable ? "asana-cli is available through PATH" : "asana-cli is not on PATH" },
    { id: "authentication", status: credential.status, message: credential.message,
      details: { configured: credential.configured, source: credential.source, verified: credential.verified } },
  ];
  return {
    schema: "asana-cli.doctor.v1", cli_version: CLI_VERSION, offline,
    status: checks.some((check) => check.status === "error") ? "error"
      : checks.some((check) => check.status === "warning") ? "warning" : "ok",
    checks,
    suggestions: [
      ...(!executable ? ["Add the installation directory to PATH"] : []),
      ...(!credential.configured ? ["Run `asana-cli auth pat set`"] : []),
    ],
  };
}
