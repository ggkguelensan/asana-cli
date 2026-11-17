import { z } from "zod";
import { CliError } from "./errors";

const knownSecrets = new Set<string>();

const SENSITIVE_KEY = /^(authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|client_secret|private_key|access_token|refresh_token|token)$/i;

export function registerSecret(value: string | undefined | null): void {
  const secret = value;
  if (secret && secret.length >= 6) {
    knownSecrets.add(secret);
    knownSecrets.add(encodeURIComponent(secret));
  }
}

export function registerEnvironmentSecrets(
  env: Record<string, string | undefined> = process.env,
): void {
  const parsed = z.record(z.string(), z.string().optional()).parse(env);
  for (const [name, value] of Object.entries(parsed)) {
    if (/(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i.test(name)) {
      registerSecret(value);
    }
  }
}

/** Prevents known process credentials from being sent as request data. */
export function assertNoKnownSecrets(input: unknown): void {
  const seen = new WeakSet<object>();
  const visit = (value: unknown): boolean => {
    if (typeof value === "string") return [...knownSecrets].some((secret) => value.includes(secret));
    if (!value || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.some(visit);
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
    return Object.values(value).some(visit);
  };
  if (visit(input)) throw new CliError("policy-denied", "Request data contains a credential known to this process");
}

export interface OutputProtectionOptions {
  maxStringLength?: number;
}

export interface OutputProtectionResult<T = unknown> {
  value: T;
  redactions: number;
  truncations: number;
}

export function protectOutput<T>(
  input: T,
  options: OutputProtectionOptions = {},
): OutputProtectionResult<T> {
  let redactions = 0;
  let truncations = 0;
  const ancestors = new WeakSet<object>();
  const maxStringLength = options.maxStringLength ?? 100_000;

  const sanitizeString = (inputString: string): string => {
    let value = inputString;
    for (const secret of [...knownSecrets].sort((left, right) => right.length - left.length)) {
      if (value.includes(secret)) {
        const occurrences = value.split(secret).length - 1;
        redactions += occurrences;
        value = value.split(secret).join("[REDACTED:KNOWN_SECRET]");
      }
    }
    if (value.length > maxStringLength) {
      truncations += 1;
      return `${value.slice(0, maxStringLength)}…[TRUNCATED ${value.length - maxStringLength} chars]`;
    }
    return value;
  };

  const walk = (value: unknown, path: string, depth: number): unknown => {
    if (typeof value === "string") return sanitizeString(value);
    if (value === null || typeof value !== "object") return value;
    if (depth > 30) {
      truncations += 1;
      return "[TRUNCATED:MAX_DEPTH]";
    }
    if (value instanceof Uint8Array) return `[BINARY:${value.byteLength}_BYTES]`;
    if (value instanceof Date) return value.toISOString();
    if (ancestors.has(value)) return "[REDACTED:CIRCULAR_REFERENCE]";
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((entry, index) => walk(entry, `${path}[${index}]`, depth + 1));
      }
      const parsed = z.looseObject({}).safeParse(value);
      if (!parsed.success) return "[REDACTED:UNSUPPORTED_OBJECT]";
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(parsed.data)) {
        const childPath = path ? `${path}.${key}` : key;
        if (SENSITIVE_KEY.test(key)) {
          if (entry !== undefined && entry !== null) redactions += 1;
          result[key] = "[REDACTED:SENSITIVE_FIELD]";
          continue;
        }
        result[key] = walk(entry, childPath, depth + 1);
      }
      return result;
    } finally {
      ancestors.delete(value);
    }
  };

  return {
    value: walk(input, "", 0) as T,
    redactions,
    truncations,
  };
}
