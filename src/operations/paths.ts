import { isAbsolute, join, win32 } from "node:path";
import { z } from "zod";

const operationPathEnvironmentSchema = z.object({
  HOME: z.string().min(1).optional(),
  XDG_STATE_HOME: z.string().min(1).optional(),
  LOCALAPPDATA: z.string().min(1).optional(),
});

export type OperationPathPlatform = "darwin" | "linux" | "win32";

function requireAbsolute(path: string, platform: OperationPathPlatform, source: string): string {
  const absolute = platform === "win32" ? win32.isAbsolute(path) : isAbsolute(path);
  if (!absolute) throw new Error(`${source} must be an absolute path`);
  return path;
}

export function resolveOperationJournalDirectory(
  environment: Record<string, string | undefined> = process.env,
  platform: OperationPathPlatform = process.platform === "win32"
    ? "win32"
    : process.platform === "darwin" ? "darwin" : "linux",
): string {
  const env = operationPathEnvironmentSchema.parse(environment);

  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? (env.HOME ? win32.join(env.HOME, "AppData", "Local") : undefined);
    if (!localAppData) throw new Error("LOCALAPPDATA or HOME is required for the operation journal");
    return win32.join(requireAbsolute(localAppData, platform, "LOCALAPPDATA"), "asana-cli", "operations");
  }

  if (env.XDG_STATE_HOME) {
    return join(requireAbsolute(env.XDG_STATE_HOME, platform, "XDG_STATE_HOME"), "asana-cli", "operations");
  }
  if (!env.HOME) throw new Error("HOME is required for the operation journal");
  const home = requireAbsolute(env.HOME, platform, "HOME");
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "asana-cli", "operations");
  }
  return join(home, ".local", "state", "asana-cli", "operations");
}

export function operationRecordPath(baseDirectory: string, id: string): string {
  return join(baseDirectory, `${z.uuid().parse(id)}.json`);
}

export function operationLockPath(baseDirectory: string, id: string): string {
  return join(baseDirectory, `${z.uuid().parse(id)}.lock`);
}
