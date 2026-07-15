import { z } from "zod";

export class CliError extends Error {
  readonly exitCode: number;
  readonly details?: unknown;

  constructor(message: string, exitCode = 2, details?: unknown) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.details = details;
  }
}

function maybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const decoded: unknown = JSON.parse(value);
    const parsed = z.json().safeParse(decoded);
    return parsed.success ? parsed.data : value;
  } catch {
    return value;
  }
}

const responseSchema = z.looseObject({
  status: z.unknown().optional(),
  body: z.unknown().optional(),
  data: z.unknown().optional(),
});

const errorShapeSchema = z.looseObject({
  status: z.unknown().optional(),
  body: z.unknown().optional(),
  response: responseSchema.optional(),
});

const apiErrorBodySchema = z.looseObject({
  message: z.string().optional(),
  errors: z.array(z.looseObject({ message: z.string().optional() })).optional(),
});

function errorShape(error: unknown): z.infer<typeof errorShapeSchema> {
  const parsed = errorShapeSchema.safeParse(error);
  return parsed.success ? parsed.data : {};
}

function responseBody(error: unknown): unknown {
  const candidate = errorShape(error);
  const body = candidate.response?.body ?? candidate.response?.data ?? candidate.body;
  if (body instanceof Uint8Array) {
    return maybeJson(new TextDecoder().decode(body));
  }
  return maybeJson(body);
}

function apiMessage(body: unknown, fallback: string): string {
  const parsed = apiErrorBodySchema.safeParse(body);
  if (parsed.success && parsed.data.errors) {
    const messages = parsed.data.errors
      .map((entry) => entry.message)
      .filter((entry): entry is string => typeof entry === "string");
    if (messages.length) return messages.join("; ");
  }
  if (parsed.success && parsed.data.message) return parsed.data.message;
  return fallback;
}

function redact(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") {
    return secrets.reduce(
      (result, secret) => (secret ? result.split(secret).join("[REDACTED]") : result),
      value,
    );
  }
  if (Array.isArray(value)) return value.map((entry) => redact(entry, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redact(entry, secrets)]),
    );
  }
  return value;
}

export function normalizeError(error: unknown, pat?: string): CliError {
  if (error instanceof CliError) return error;

  const candidate = errorShape(error);
  const status = Number(candidate.status ?? candidate.response?.status ?? 0);
  const body = responseBody(error);
  const fallback = error instanceof Error ? error.message : String(error);
  const message = apiMessage(body, fallback || "Unknown error");
  const details = redact(body, pat ? [pat] : []);

  if (status === 401 || status === 403) {
    return new CliError(`Asana authentication failed (${status}): ${message}`, 3, details);
  }
  if (status) {
    return new CliError(`Asana API error (${status}): ${message}`, 4, details);
  }
  return new CliError(message, 1, details);
}

export function errorStatus(error: unknown): number {
  const candidate = errorShape(error);
  return Number(candidate.status ?? candidate.response?.status ?? 0);
}

export function errorPayload(error: CliError): Record<string, unknown> {
  return {
    error: {
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
      exit_code: error.exitCode,
    },
  };
}
