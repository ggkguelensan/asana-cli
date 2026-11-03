import { CliError } from "./errors";
import { z } from "zod";

const SERVICE = "com.github.ggkguelensan.asana-cli";
const NAME = "asana-pat";

export type PatSource = "ASANA_PAT" | "ASANA_ACCESS_TOKEN" | "os-credential-store";

export interface ResolvedPat {
  pat: string;
  source: PatSource;
}

const credentialEnvironmentSchema = z.object({
  ASANA_ACCESS_TOKEN: z.string().optional(),
  ASANA_PAT: z.string().optional(),
});

const patSchema = z.string()
  .min(1, "PAT must not be empty")
  .max(8_192, "PAT exceeds the 8 KiB safety limit")
  .refine((value) => !/[\r\n\0]/.test(value), "PAT must not contain line breaks or NUL bytes");

function envPat(env: Record<string, string | undefined>): ResolvedPat | undefined {
  const parsed = credentialEnvironmentSchema.parse(env);
  if (parsed.ASANA_ACCESS_TOKEN) {
    return { pat: validatePat(parsed.ASANA_ACCESS_TOKEN), source: "ASANA_ACCESS_TOKEN" };
  }
  if (parsed.ASANA_PAT) return { pat: validatePat(parsed.ASANA_PAT), source: "ASANA_PAT" };
  return undefined;
}

export function validatePat(value: string): string {
  const parsed = patSchema.safeParse(value);
  if (!parsed.success) {
    throw new CliError("validation", parsed.error.issues[0]?.message ?? "Invalid PAT");
  }
  return parsed.data;
}

export function patFromStdin(text: string): string {
  const value = text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text;
  return validatePat(value);
}

export async function storedPat(): Promise<string | null> {
  try {
    return z.string().nullable().parse(
      await Bun.secrets.get({ service: SERVICE, name: NAME }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(
      "storage-invalid",
      `Cannot access the OS credential store: ${message}. Use ASANA_ACCESS_TOKEN as a fallback.`,
    );
  }
}

export async function resolvePatWithSource(
  env: Record<string, string | undefined> = process.env,
  readStoredPat: () => Promise<string | null> = storedPat,
): Promise<ResolvedPat> {
  const fromEnvironment = envPat(env);
  if (fromEnvironment) return fromEnvironment;
  const stored = await readStoredPat();
  if (stored) return { pat: validatePat(stored), source: "os-credential-store" };
  throw new CliError(
    "auth-required",
    "No Asana PAT found. Run `asana-cli auth pat set` or export ASANA_ACCESS_TOKEN.",
  );
}

export async function savePat(pat: string): Promise<void> {
  validatePat(pat);
  try {
    await Bun.secrets.set({ service: SERVICE, name: NAME, value: pat });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError("storage-invalid", `Cannot store PAT in the OS credential store: ${message}`);
  }
}

export async function deleteStoredPat(): Promise<boolean> {
  try {
    return z.boolean().parse(
      await Bun.secrets.delete({ service: SERVICE, name: NAME }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError("storage-invalid", `Cannot delete PAT from the OS credential store: ${message}`);
  }
}

export async function readPatInteractively(): Promise<string> {
  if (!process.stdin.isTTY) {
    return patFromStdin(await Bun.stdin.text());
  }
  if (!process.stdin.setRawMode) {
    throw new CliError("usage", "Hidden input is unavailable; pipe the PAT with --stdin instead");
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
      else if (!value) reject(new CliError("validation", "PAT must not be empty"));
      else resolve(validatePat(value));
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          finish(new CliError("interrupted", "Interrupted"));
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
