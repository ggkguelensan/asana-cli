import { CliError } from "./errors";

const BASE_URL = "https://app.asana.com/api/1.0";
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export interface RawRequestOptions {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  data?: unknown;
  fetchImpl?: typeof fetch;
}

export async function rawRequest(pat: string, options: RawRequestOptions): Promise<unknown> {
  const method = options.method.toUpperCase();
  if (!METHODS.has(method)) {
    throw new CliError(`Unsupported HTTP method: ${options.method}`, 2);
  }
  if (!options.path.startsWith("/") || options.path.startsWith("//")) {
    throw new CliError("API path must be relative and start with a single /", 2);
  }

  const url = new URL(`${BASE_URL}${options.path}`);
  for (const [name, value] of Object.entries(options.query ?? {})) {
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
  const response = await (options.fetchImpl ?? fetch)(url, {
    method,
    redirect: "error",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${pat}`,
      "User-Agent": "asana-cli/0.1.0",
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
    },
    ...(hasBody ? { body: JSON.stringify(options.data) } : {}),
  });
  const text = await response.text();
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    const messages = Array.isArray((body as any)?.errors)
      ? (body as any).errors.map((entry: any) => entry?.message).filter(Boolean).join("; ")
      : response.statusText;
    throw new CliError(
      `Asana API error (${response.status}): ${messages || "Request failed"}`,
      response.status === 401 || response.status === 403 ? 3 : 4,
      body,
    );
  }
  return body;
}
