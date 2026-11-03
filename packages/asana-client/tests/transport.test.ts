import { expect, test } from "bun:test";
import { createAsanaTransport, AsanaTransportError } from "../src";

test("uses the configured SDK endpoint without exposing credentials or SDK internals", async () => {
  let authorization = "";
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      authorization = request.headers.get("authorization") ?? "";
      return Response.json({ data: { gid: "123", name: "Fixture" } });
    },
  });
  try {
    const transport = createAsanaTransport("ADAPTER_CANARY", {
      baseUrl: new URL("/api/1.0", server.url).toString(),
    });
    expect(await transport.invoke("TasksApi", "getTask", ["123", {}])).toMatchObject({
      data: { gid: "123", name: "Fixture" },
    });
    expect(authorization).toBe("Bearer ADAPTER_CANARY");
    expect(Object.keys(transport)).toEqual(["invoke"]);
    expect(JSON.stringify(transport)).not.toContain("ADAPTER_CANARY");
    await expect(transport.invoke("TasksApi", "getTaskWithHttpInfo", []))
      .rejects.toBeInstanceOf(AsanaTransportError);
  } finally { server.stop(true); }
});
