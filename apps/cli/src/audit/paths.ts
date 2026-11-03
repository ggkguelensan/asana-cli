import { isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  assertSupportedRuntimePlatform,
  type SupportedRuntimePlatform,
} from "../platform-support";

const auditPathEnvironmentSchema = z.object({
  HOME: z.string().min(1).optional(),
  XDG_STATE_HOME: z.string().min(1).optional(),
});

export type AuditPathPlatform = SupportedRuntimePlatform;

function requireAbsolute(path: string, source: string): string {
  if (!isAbsolute(path)) throw new Error(`${source} must be an absolute path`);
  return path;
}

export function resolveAuditLogDirectory(
  environment: Record<string, string | undefined> = process.env,
  platform: AuditPathPlatform = assertSupportedRuntimePlatform(),
): string {
  const env = auditPathEnvironmentSchema.parse(environment);

  if (env.XDG_STATE_HOME) {
    return join(requireAbsolute(env.XDG_STATE_HOME, "XDG_STATE_HOME"), "asana-cli", "audit");
  }
  if (!env.HOME) throw new Error("HOME is required for the audit log");
  const home = requireAbsolute(env.HOME, "HOME");
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "asana-cli", "audit");
  }
  return join(home, ".local", "state", "asana-cli", "audit");
}

export function auditEventPath(baseDirectory: string, eventId: string): string {
  return join(baseDirectory, `${z.uuid().parse(eventId)}.json`);
}
