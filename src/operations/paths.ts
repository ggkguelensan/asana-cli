import { isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  assertSupportedRuntimePlatform,
  type SupportedRuntimePlatform,
} from "../platform-support";

const operationPathEnvironmentSchema = z.object({
  HOME: z.string().min(1).optional(),
  XDG_STATE_HOME: z.string().min(1).optional(),
});

export type OperationPathPlatform = SupportedRuntimePlatform;

function requireAbsolute(path: string, source: string): string {
  if (!isAbsolute(path)) throw new Error(`${source} must be an absolute path`);
  return path;
}

export function resolveOperationJournalDirectory(
  environment: Record<string, string | undefined> = process.env,
  platform: OperationPathPlatform = assertSupportedRuntimePlatform(),
): string {
  const env = operationPathEnvironmentSchema.parse(environment);

  if (env.XDG_STATE_HOME) {
    return join(requireAbsolute(env.XDG_STATE_HOME, "XDG_STATE_HOME"), "asana-cli", "operations");
  }
  if (!env.HOME) throw new Error("HOME is required for the operation journal");
  const home = requireAbsolute(env.HOME, "HOME");
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
