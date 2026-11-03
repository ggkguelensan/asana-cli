import * as Asana from "asana";
import type { AsanaTransport } from "@asana-cli/asana-client";

/** Business tests stub SDK HTTP responses; production callers never receive this SDK handle. */
export function asanaFixture(): { client: AsanaTransport; sdk: Asana.ApiClient } {
  const sdk = new Asana.ApiClient();
  return {
    sdk,
    client: {
      async invoke(className, methodName, args) {
        const constructor = Object.entries(Asana).find(([name]) => name === className)?.[1];
        if (typeof constructor !== "function") throw new Error(`Missing fixture API ${className}`);
        const instance: Record<string, unknown> = Reflect.construct(constructor, [sdk]);
        const method = instance[methodName];
        if (typeof method !== "function") throw new Error(`Missing fixture method ${methodName}`);
        return Reflect.apply(method, instance, args);
      },
    },
  };
}
