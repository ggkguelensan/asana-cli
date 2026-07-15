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
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function responseBody(error: any): unknown {
  const body = error?.response?.body ?? error?.response?.data ?? error?.body;
  if (body instanceof Uint8Array) {
    return maybeJson(new TextDecoder().decode(body));
  }
  return maybeJson(body);
}

function apiMessage(body: any, fallback: string): string {
  if (Array.isArray(body?.errors)) {
    const messages = body.errors
      .map((entry: any) => entry?.message)
      .filter((entry: unknown): entry is string => typeof entry === "string");
    if (messages.length) return messages.join("; ");
  }
  if (typeof body?.message === "string") return body.message;
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

  const candidate = error as any;
  const status = Number(candidate?.status ?? candidate?.response?.status ?? 0);
  const body = responseBody(candidate);
  const fallback = candidate instanceof Error ? candidate.message : String(candidate);
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
  const candidate = error as any;
  return Number(candidate?.status ?? candidate?.response?.status ?? 0);
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
