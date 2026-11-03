import {
  createAsanaTransport, AsanaTransportError, apiClass,
  apiClassNames, apiMethodNames as transportMethods,
  type AsanaTransport,
} from "@asana-cli/asana-client";
import { z } from "zod";
import { CliError } from "./errors";
import { resolvePatWithSource } from "./pat-store";
import { registerSecret } from "./security";
import { zodIssueSummary } from "./schemas";

export type AsanaClient = AsanaTransport;
export { apiClassNames };

function translateError(error: unknown): never {
  if (error instanceof AsanaTransportError) throw new CliError(error.code, error.message);
  throw error;
}
function sdkBoundary<T>(operation: () => T): T {
  try { return operation(); } catch (error) { return translateError(error); }
}
export function resolveApiClass(name: string): { name: string } {
  return sdkBoundary(() => apiClass(name));
}
export function apiMethodNames(name: string, includeHttpInfo = false): string[] {
  return sdkBoundary(() => transportMethods(name, includeHttpInfo));
}
export async function invokeApiMethod(
  client: AsanaClient, className: string, methodName: string, args: unknown[],
): Promise<unknown> {
  try { return await client.invoke(className, methodName, args); }
  catch (error) { return translateError(error); }
}
export async function resolvePat(
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  return (await resolvePatWithSource(env)).pat;
}
export function createClient(pat: string, options: { baseUrl?: string } = {}): AsanaClient {
  registerSecret(pat);
  return sdkBoundary(() => createAsanaTransport(pat, options));
}

export interface CollectionLike {
  data: unknown[] | null;
  _response?: { next_page?: unknown };
  nextPage?: () => Promise<CollectionLike>;
}

const collectionBoundarySchema = z.looseObject({
  data: z.array(z.unknown()).nullable(),
  _response: z.looseObject({ next_page: z.unknown().optional() }).optional(),
  nextPage: z.function().optional(),
});

export function isCollection(value: unknown): value is CollectionLike {
  const parsed = collectionBoundarySchema.safeParse(value);
  return parsed.success && Array.isArray(parsed.data.data) && typeof parsed.data.nextPage === "function";
}

export function normalizeSdkResult(value: unknown): unknown {
  if (!isCollection(value)) return value;
  return {
    data: value.data,
    next_page: value._response?.next_page ?? null,
  };
}

export async function collectPages<T>(
  first: CollectionLike,
  all: boolean,
  maxResults: number,
  itemSchema: z.ZodType<T>,
  context = "Asana collection",
  reportTruncation = false,
): Promise<{ data: T[]; next_page: unknown; truncated?: boolean }> {
  const data: T[] = [];
  let page: CollectionLike | undefined = first;
  const result = (nextPage: unknown, truncated: boolean) => ({
    data,
    next_page: nextPage,
    ...(reportTruncation ? { truncated } : {}),
  });

  while (page && Array.isArray(page.data)) {
    const remaining = maxResults - data.length;
    if (remaining <= 0) {
      return result(page._response?.next_page ?? null, true);
    }
    const pageWasSliced = page.data.length > remaining;
    const parsedItems = z.array(itemSchema).safeParse(page.data.slice(0, remaining));
    if (!parsedItems.success) {
      throw new CliError(
        "internal",
        `Invalid response data from ${context}: ${zodIssueSummary(parsedItems.error)}`,
      );
    }
    data.push(...parsedItems.data);
    const nextPage = page._response?.next_page ?? null;
    if (pageWasSliced) return result(nextPage, true);
    if (!all || !nextPage || data.length >= maxResults || !page.nextPage) {
      return result(nextPage, nextPage !== null && nextPage !== undefined);
    }
    page = await page.nextPage();
  }

  return result(null, false);
}

export function asCollection(value: unknown, context: string): CollectionLike {
  if (!isCollection(value)) {
    throw new CliError("internal", `Unexpected non-collection response from ${context}`);
  }
  return value;
}
