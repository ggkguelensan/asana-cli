import { CliError } from "./errors";

const SERVICE = "com.github.ggkguelensan.asana-cli";
const NAME = "asana-pat";

export type PatSource = "ASANA_PAT" | "ASANA_ACCESS_TOKEN" | "os-credential-store";

export interface ResolvedPat {
  pat: string;
  source: PatSource;
}

function envPat(env: Record<string, string | undefined>): ResolvedPat | undefined {
  if (env.ASANA_ACCESS_TOKEN) {
    return { pat: validatePat(env.ASANA_ACCESS_TOKEN), source: "ASANA_ACCESS_TOKEN" };
  }
  if (env.ASANA_PAT) return { pat: validatePat(env.ASANA_PAT), source: "ASANA_PAT" };
  return undefined;
}

export function validatePat(value: string): string {
  if (!value) throw new CliError("PAT must not be empty", 2);
  if (value.length > 8_192) throw new CliError("PAT exceeds the 8 KiB safety limit", 2);
  if (/[\r\n\0]/.test(value)) {
    throw new CliError("PAT must not contain line breaks or NUL bytes", 2);
  }
  return value;
}

export function patFromStdin(text: string): string {
  const value = text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text;
  return validatePat(value);
}

export async function storedPat(): Promise<string | null> {
  try {
    return await Bun.secrets.get({ service: SERVICE, name: NAME });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(
      `Cannot access the OS credential store: ${message}. Use ASANA_ACCESS_TOKEN as a fallback.`,
      3,
    );
  }
}

export async function resolvePatWithSource(
  env: Record<string, string | undefined> = process.env,
): Promise<ResolvedPat> {
  const fromEnvironment = envPat(env);
  if (fromEnvironment) return fromEnvironment;
  const stored = await storedPat();
  if (stored) return { pat: validatePat(stored), source: "os-credential-store" };
  throw new CliError(
    "No Asana PAT found. Run `asana-cli auth pat set` or export ASANA_ACCESS_TOKEN.",
    3,
  );
}

export async function savePat(pat: string): Promise<void> {
  validatePat(pat);
  try {
    await Bun.secrets.set({ service: SERVICE, name: NAME, value: pat });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Cannot store PAT in the OS credential store: ${message}`, 3);
  }
}

export async function deleteStoredPat(): Promise<boolean> {
  try {
    return await Bun.secrets.delete({ service: SERVICE, name: NAME });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Cannot delete PAT from the OS credential store: ${message}`, 3);
  }
}

export async function readPatInteractively(): Promise<string> {
  if (!process.stdin.isTTY) {
    return patFromStdin(await Bun.stdin.text());
  }
  if (!process.stdin.setRawMode) {
    throw new CliError("Hidden input is unavailable; pipe the PAT with --stdin instead", 2);
  }

  process.stderr.write("Asana PAT (input hidden): ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else if (!value) reject(new CliError("PAT must not be empty", 2));
      else resolve(validatePat(value));
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          finish(new CliError("Interrupted", 130));
          return;
        }
        if (character === "\r" || character === "\n" || character === "\u0004") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else {
          value += character;
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

export const PAT_STORE_INFO = {
  service: SERVICE,
  name: NAME,
};
