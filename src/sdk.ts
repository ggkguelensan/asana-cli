import * as AsanaModule from "asana";
import { z } from "zod";
import { CliError } from "./errors";
import { resolvePatWithSource } from "./pat-store";
import { registerSecret } from "./security";
import { zodIssueSummary } from "./schemas";

export type AsanaClient = InstanceType<typeof AsanaModule.ApiClient>;

interface ApiInstance {
  [methodName: string]: unknown;
}

interface ApiConstructor {
  new(client?: AsanaClient): ApiInstance;
  readonly prototype: ApiInstance;
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

const asanaExports = Object.entries(AsanaModule) as Array<[string, unknown]>;

export async function resolvePat(
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  return (await resolvePatWithSource(env)).pat;
}

export function createClient(pat: string): AsanaClient {
  registerSecret(pat);
  const client = new AsanaModule.ApiClient();
  if (!client.authentications.token) {
    throw new CliError("node-asana did not expose token authentication", 1);
  }
  client.authentications.token.accessToken = pat;
  return client;
}

export function apiClassNames(): string[] {
  return asanaExports
    .filter(([name, value]) => name.endsWith("Api") && typeof value === "function")
    .map(([name]) => name)
    .sort();
}

export function resolveApiClass(name: string): { name: string; constructor: ApiConstructor } {
  const requested = name.endsWith("Api") ? name : `${name}Api`;
  const actual = apiClassNames().find(
    (candidate) => candidate.toLowerCase() === requested.toLowerCase(),
  );
  if (!actual) {
    throw new CliError(
      `Unknown Asana API class: ${name}. Run \`asana-cli api list\` to see available classes.`,
      2,
    );
  }
  const exported = asanaExports.find(([exportName]) => exportName === actual)?.[1];
  if (typeof exported !== "function") {
    throw new CliError(`Asana API export ${actual} is not constructable`, 1);
  }
  return { name: actual, constructor: exported as unknown as ApiConstructor };
}

export function apiMethodNames(className: string, includeHttpInfo = false): string[] {
  const resolved = resolveApiClass(className);
  return Object.getOwnPropertyNames(resolved.constructor.prototype)
    .filter((name) => name !== "constructor")
    .filter((name) => typeof resolved.constructor.prototype[name] === "function")
    .filter((name) => includeHttpInfo || !name.endsWith("WithHttpInfo"))
    .sort();
}

export async function invokeApiMethod(
  client: AsanaClient,
  className: string,
  methodName: string,
  args: unknown[],
): Promise<unknown> {
  const resolved = resolveApiClass(className);
  const instance = new resolved.constructor(client);
  const actualMethod = Object.getOwnPropertyNames(resolved.constructor.prototype).find(
    (candidate) => candidate.toLowerCase() === methodName.toLowerCase(),
  );
  if (
    !actualMethod ||
    actualMethod === "constructor" ||
    actualMethod.endsWith("WithHttpInfo") ||
    typeof instance[actualMethod] !== "function"
  ) {
    throw new CliError(
      `Unknown method ${resolved.name}.${methodName}. Run \`asana-cli api list ${resolved.name}\`.`,
      2,
    );
  }
  const method = instance[actualMethod];
  if (typeof method !== "function") {
    throw new CliError(`Asana method ${resolved.name}.${actualMethod} is not callable`, 1);
  }
  const result: unknown = await Reflect.apply(method, instance, args);
  return result;
}

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
): Promise<{ data: T[]; next_page: unknown }> {
  const data: T[] = [];
  let page: CollectionLike | undefined = first;

  while (page && Array.isArray(page.data)) {
    const remaining = maxResults - data.length;
    if (remaining <= 0) break;
    const parsedItems = z.array(itemSchema).safeParse(page.data.slice(0, remaining));
    if (!parsedItems.success) {
      throw new CliError(
        `Invalid response data from ${context}: ${zodIssueSummary(parsedItems.error)}`,
        1,
      );
    }
    data.push(...parsedItems.data);
    const nextPage = page._response?.next_page ?? null;
    if (!all || !nextPage || data.length >= maxResults || !page.nextPage) {
      return { data, next_page: nextPage };
    }
    page = await page.nextPage();
  }

  return { data, next_page: null };
}

export function asCollection(value: unknown, context: string): CollectionLike {
  if (!isCollection(value)) {
    throw new CliError(`Unexpected non-collection response from ${context}`, 1);
  }
  return value;
}
