import { isAbsolute, join, win32 } from "node:path";
import { z } from "zod";

const auditPathEnvironmentSchema = z.object({
  HOME: z.string().min(1).optional(),
  XDG_STATE_HOME: z.string().min(1).optional(),
  LOCALAPPDATA: z.string().min(1).optional(),
});

export type AuditPathPlatform = "darwin" | "linux" | "win32";

function requireAbsolute(path: string, platform: AuditPathPlatform, source: string): string {
  const absolute = platform === "win32" ? win32.isAbsolute(path) : isAbsolute(path);
  if (!absolute) throw new Error(`${source} must be an absolute path`);
  return path;
}

export function resolveAuditLogDirectory(
  environment: Record<string, string | undefined> = process.env,
  platform: AuditPathPlatform = process.platform === "win32"
    ? "win32"
    : process.platform === "darwin" ? "darwin" : "linux",
): string {
  const env = auditPathEnvironmentSchema.parse(environment);

  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? (env.HOME ? win32.join(env.HOME, "AppData", "Local") : undefined);
    if (!localAppData) throw new Error("LOCALAPPDATA or HOME is required for the audit log");
    return win32.join(requireAbsolute(localAppData, platform, "LOCALAPPDATA"), "asana-cli", "audit");
  }

  if (env.XDG_STATE_HOME) {
    return join(requireAbsolute(env.XDG_STATE_HOME, platform, "XDG_STATE_HOME"), "asana-cli", "audit");
  }
  if (!env.HOME) throw new Error("HOME is required for the audit log");
  const home = requireAbsolute(env.HOME, platform, "HOME");
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "asana-cli", "audit");
  }
  return join(home, ".local", "state", "asana-cli", "audit");
}

export function auditEventPath(baseDirectory: string, eventId: string): string {
  return join(baseDirectory, `${z.uuid().parse(eventId)}.json`);
}
