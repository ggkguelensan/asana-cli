import * as AsanaModule from "asana";

type SdkClient = InstanceType<typeof AsanaModule.ApiClient>;
interface ApiInstance { [methodName: string]: unknown; }
interface ApiConstructor {
  new(client?: SdkClient): ApiInstance;
  readonly prototype: ApiInstance;
}
const asanaExports = Object.entries(AsanaModule) as Array<[string, unknown]>;

/** Callers own credential storage, authorization policy and presentation. */
export interface AsanaTransport {
  invoke(className: string, methodName: string, args: unknown[]): Promise<unknown>;
}
export class AsanaTransportError extends Error {
  constructor(readonly code: "usage" | "internal", message: string) {
    super(message);
    this.name = "AsanaTransportError";
  }
}
export function createAsanaTransport(token: string, options: { baseUrl?: string } = {}): AsanaTransport {
  const client = new AsanaModule.ApiClient();
  if (!client.authentications.token) {
    throw new AsanaTransportError("internal", "node-asana did not expose token authentication");
  }
  client.authentications.token.accessToken = token;
  if (options.baseUrl) client.basePath = options.baseUrl;
  return { invoke: (className, methodName, args) => invokeSdkMethod(client, className, methodName, args) };
}
export function apiClass(name: string): { name: string } {
  return { name: resolveApiClass(name).name };
}
export function apiClassNames(): string[] {
  return asanaExports
    .filter(([name, value]) => name.endsWith("Api") && typeof value === "function")
    .map(([name]) => name)
    .sort();
}

function sdkExport(name: string): unknown {
  return asanaExports.find(([exportName]) => exportName === name)?.[1];
}
function isPublicMethod(name: string | undefined): name is string {
  return Boolean(name && name !== "constructor" && !name.endsWith("WithHttpInfo"));
}
function resolveApiClass(name: string): { name: string; constructor: ApiConstructor } {
  const requested = name.endsWith("Api") ? name : `${name}Api`;
  const actual = apiClassNames().find(
    (candidate) => candidate.toLowerCase() === requested.toLowerCase(),
  );
  if (!actual) {
    throw new AsanaTransportError(
      "usage",
      `Unknown Asana API class: ${name}.`,
    );
  }
  const exported = sdkExport(actual);
  if (typeof exported !== "function") {
    throw new AsanaTransportError("internal", `Asana API export ${actual} is not constructable`);
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

async function invokeSdkMethod(
  client: SdkClient,
  className: string,
  methodName: string,
  args: unknown[],
): Promise<unknown> {
  const resolved = resolveApiClass(className);
  const instance = new resolved.constructor(client);
  const actualMethod = Object.getOwnPropertyNames(resolved.constructor.prototype).find(
    (candidate) => candidate.toLowerCase() === methodName.toLowerCase(),
  );
  if (!isPublicMethod(actualMethod)) {
    throw new AsanaTransportError(
      "usage",
      `Unknown method ${resolved.name}.${methodName}.`,
    );
  }
  const method = instance[actualMethod];
  if (typeof method !== "function") {
    throw new AsanaTransportError("internal", `Asana method ${resolved.name}.${actualMethod} is not callable`);
  }
  const result: unknown = await Reflect.apply(method, instance, args);
  return result;
}
