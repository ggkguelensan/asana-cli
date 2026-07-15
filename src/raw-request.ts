import { CliError } from "./errors";
import { z } from "zod";
import { jsonObjectSchema, jsonValueSchema } from "./schemas";
import { CLI_VERSION } from "./version";

const BASE_URL = "https://app.asana.com/api/1.0";
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export interface RawRequestOptions {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  data?: unknown;
  fetchImpl?: typeof fetch;
}

const rawErrorSchema = z.looseObject({
  errors: z.array(z.looseObject({ message: z.string().optional() })).optional(),
});

export async function rawRequest(pat: string, options: RawRequestOptions): Promise<unknown> {
  const method = options.method.toUpperCase();
  if (!METHODS.has(method)) {
    throw new CliError(`Unsupported HTTP method: ${options.method}`, 2);
  }
  if (!options.path.startsWith("/") || options.path.startsWith("//")) {
    throw new CliError("API path must be relative and start with a single /", 2);
  }

  const url = new URL(`${BASE_URL}${options.path}`);
  const queryResult = jsonObjectSchema.safeParse(options.query ?? {});
  if (!queryResult.success) throw new CliError("Raw request query must contain JSON values", 2);
  for (const [name, value] of Object.entries(queryResult.data)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(name, String(item));
    } else if (value && typeof value === "object") {
      url.searchParams.set(name, JSON.stringify(value));
    } else {
      url.searchParams.set(name, String(value));
    }
  }

  const hasBody = options.data !== undefined && method !== "GET";
  if (hasBody && !jsonValueSchema.safeParse(options.data).success) {
    throw new CliError("Raw request body must be a JSON value", 2);
  }
  const response = await (options.fetchImpl ?? fetch)(url, {
    method,
    redirect: "error",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${pat}`,
      "User-Agent": `asana-cli/${CLI_VERSION}`,
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
    },
    ...(hasBody ? { body: JSON.stringify(options.data) } : {}),
  });
  const text = await response.text();
  let body: unknown = {};
  if (text) {
    try {
      const decoded: unknown = JSON.parse(text);
      const parsed = jsonValueSchema.safeParse(decoded);
      body = parsed.success ? parsed.data : text;
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    const parsed = rawErrorSchema.safeParse(body);
    const messages = parsed.success && parsed.data.errors
      ? parsed.data.errors.flatMap((entry) => entry.message ? [entry.message] : []).join("; ")
      : response.statusText;
    throw new CliError(
      `Asana API error (${response.status}): ${messages || "Request failed"}`,
      response.status === 401 || response.status === 403 ? 3 : 4,
      body,
    );
  }
  return body;
}
