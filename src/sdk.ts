import * as AsanaModule from "asana";
import { CliError } from "./errors";
import { resolvePatWithSource } from "./pat-store";
import { registerSecret } from "./security";

const Asana = AsanaModule as unknown as Record<string, any>;

export interface CollectionLike<T = unknown> {
  data: T[] | null;
  _response?: { next_page?: unknown };
  nextPage?: () => Promise<CollectionLike<T>>;
}

export async function resolvePat(
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  return (await resolvePatWithSource(env)).pat;
}

export function createClient(pat: string): any {
  registerSecret(pat);
  const client = new Asana.ApiClient();
  client.authentications.token.accessToken = pat;
  return client;
}

export function apiClassNames(): string[] {
  return Object.entries(Asana)
    .filter(([name, value]) => name.endsWith("Api") && typeof value === "function")
    .map(([name]) => name)
    .sort();
}

export function resolveApiClass(name: string): { name: string; constructor: any } {
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
  return { name: actual, constructor: Asana[actual] };
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
  client: any,
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
  return instance[actualMethod](...args);
}

export function isCollection(value: unknown): value is CollectionLike {
  return Boolean(
    value &&
      typeof value === "object" &&
      Array.isArray((value as CollectionLike).data) &&
      typeof (value as CollectionLike).nextPage === "function",
  );
}

export function normalizeSdkResult(value: unknown): unknown {
  if (!isCollection(value)) return value;
  return {
    data: value.data,
    next_page: value._response?.next_page ?? null,
  };
}

export async function collectPages<T>(
  first: CollectionLike<T>,
  all: boolean,
  maxResults: number,
): Promise<{ data: T[]; next_page: unknown }> {
  const data: T[] = [];
  let page: CollectionLike<T> | undefined = first;

  while (page && Array.isArray(page.data)) {
    const remaining = maxResults - data.length;
    if (remaining <= 0) break;
    data.push(...page.data.slice(0, remaining));
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
