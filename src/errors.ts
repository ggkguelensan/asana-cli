import { z } from "zod";

export const cliErrorCodeSchema = z.enum([
  "usage",
  "validation",
  "auth-required",
  "auth-failed",
  "policy-denied",
  "not-found",
  "conflict",
  "stale",
  "expired",
  "unknown-result",
  "storage-locked",
  "storage-invalid",
  "network",
  "asana-api",
  "internal",
  "interrupted",
]);

export type CliErrorCode = z.output<typeof cliErrorCodeSchema>;

const errorCodeDescriptorSchema = z.strictObject({
  default_exit_code: z.number().int().min(0).max(255),
  retryable: z.boolean(),
});

export const CLI_ERROR_REGISTRY = z.record(
  cliErrorCodeSchema,
  errorCodeDescriptorSchema,
).parse({
  usage: { default_exit_code: 2, retryable: false },
  validation: { default_exit_code: 2, retryable: false },
  "auth-required": { default_exit_code: 3, retryable: false },
  "auth-failed": { default_exit_code: 3, retryable: false },
  "policy-denied": { default_exit_code: 2, retryable: false },
  "not-found": { default_exit_code: 4, retryable: false },
  conflict: { default_exit_code: 4, retryable: false },
  stale: { default_exit_code: 4, retryable: false },
  expired: { default_exit_code: 4, retryable: false },
  "unknown-result": { default_exit_code: 4, retryable: false },
  "storage-locked": { default_exit_code: 4, retryable: true },
  "storage-invalid": { default_exit_code: 3, retryable: false },
  network: { default_exit_code: 1, retryable: true },
  "asana-api": { default_exit_code: 4, retryable: false },
  internal: { default_exit_code: 1, retryable: false },
  interrupted: { default_exit_code: 130, retryable: false },
});

const errorDetailsSchema = z.json();

export const errorPayloadSchema = z.strictObject({
  error: z.strictObject({
    code: cliErrorCodeSchema,
    message: z.string(),
    details: errorDetailsSchema.optional(),
    exit_code: z.number().int().min(0).max(255),
  }),
});

export const AGENT_ERROR_SCHEMA_ID = "asana-cli.agent.error.v1" as const;

export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly exitCode: number;
  readonly details?: z.output<typeof errorDetailsSchema>;

  constructor(
    code: CliErrorCode,
    message: string,
    exitCode = CLI_ERROR_REGISTRY[code].default_exit_code,
    details?: unknown,
  ) {
    super(message);
    this.name = "CliError";
    this.code = cliErrorCodeSchema.parse(code);
    this.exitCode = z.number().int().min(0).max(255).parse(exitCode);
    const parsedDetails = errorDetailsSchema.safeParse(details);
    this.details = parsedDetails.success ? parsedDetails.data : undefined;
  }
}

function maybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const decoded: unknown = JSON.parse(value);
    const parsed = errorDetailsSchema.safeParse(decoded);
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

const operationJournalErrorCodeSchema = z.enum([
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "INVALID_RECORD",
  "INSECURE_STORAGE",
  "LOCKED",
  "CORRUPT_LOCK",
  "STORAGE_ERROR",
]);

const operationJournalErrorSchema = z.looseObject({
  name: z.literal("OperationJournalError"),
  code: operationJournalErrorCodeSchema,
  message: z.string(),
});

const operationErrorCodeMap = z.record(
  operationJournalErrorCodeSchema,
  cliErrorCodeSchema,
).parse({
  NOT_FOUND: "not-found",
  ALREADY_EXISTS: "conflict",
  INVALID_RECORD: "storage-invalid",
  INSECURE_STORAGE: "storage-invalid",
  LOCKED: "storage-locked",
  CORRUPT_LOCK: "storage-invalid",
  STORAGE_ERROR: "storage-invalid",
});

const networkErrorSchema = z.looseObject({
  code: z.string().optional(),
  cause: z.looseObject({ code: z.string().optional() }).optional(),
});

const transportErrorCodeSchema = z.string().regex(
  /^(?:ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONN[A-Z0-9_]+|ENET[A-Z0-9_]+|EHOST[A-Z0-9_]+|UND_ERR_[A-Z0-9_]+)$/,
);

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

function apiMessages(body: unknown): string[] {
  const parsed = apiErrorBodySchema.safeParse(body);
  if (!parsed.success) return [];
  const errors = parsed.data.errors
    ?.flatMap((entry) => entry.message ? [entry.message] : [])
    .slice(0, 8) ?? [];
  if (errors.length) return errors;
  return parsed.data.message ? [parsed.data.message] : [];
}

function redactText(value: string, secrets: string[]): string {
  return secrets.reduce(
    (result, secret) => (secret ? result.split(secret).join("[REDACTED]") : result),
    value,
  );
}

function httpStatus(error: unknown): number | undefined {
  const candidate = errorShape(error);
  const parsed = z.coerce.number().int().min(100).max(599).safeParse(
    candidate.status ?? candidate.response?.status,
  );
  return parsed.success ? parsed.data : undefined;
}

export function asanaHttpErrorCode(status: number): CliErrorCode {
  if (status === 401 || status === 403) return "auth-failed";
  if (status === 404) return "not-found";
  if (status === 409 || status === 412) return "conflict";
  return "asana-api";
}

function operationError(error: unknown): CliError | undefined {
  const parsed = operationJournalErrorSchema.safeParse(error);
  if (!parsed.success) return undefined;
  return new CliError(operationErrorCodeMap[parsed.data.code], parsed.data.message);
}

function isNetworkError(error: unknown): boolean {
  const parsed = networkErrorSchema.safeParse(error);
  if (parsed.success) {
    const codes = [parsed.data.code, parsed.data.cause?.code];
    if (codes.some((code) => transportErrorCodeSchema.safeParse(code).success)) return true;
  }
  if (!(error instanceof TypeError)) return false;
  return /^(?:fetch failed|Unable to connect)(?:[.:]|$)/i.test(error.message.trim());
}

export function normalizeError(error: unknown, pat?: string): CliError {
  if (error instanceof CliError) return error;

  const journalError = operationError(error);
  if (journalError) return journalError;

  const status = httpStatus(error);
  const body = responseBody(error);
  const secrets = pat ? [pat] : [];
  const fallback = error instanceof Error ? error.message : String(error);
  const messages = apiMessages(body).map((message) => redactText(message, secrets));
  const message = messages.join("; ") || redactText(fallback || "Unknown error", secrets);

  if (status !== undefined) {
    const code = asanaHttpErrorCode(status);
    const prefix = code === "auth-failed" ? "Asana authentication failed" : "Asana API error";
    return new CliError(code, `${prefix} (${status}): ${message}`, undefined, {
      http_status: status,
      ...(messages.length ? { errors: messages } : {}),
    });
  }
  if (isNetworkError(error)) return new CliError("network", message);
  return new CliError("internal", message);
}

export function errorStatus(error: unknown): number {
  return httpStatus(error) ?? 0;
}

export function errorPayload(error: CliError): z.output<typeof errorPayloadSchema> {
  return errorPayloadSchema.parse({
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
      exit_code: error.exitCode,
    },
  });
}
