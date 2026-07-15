import { describe, expect, test } from "bun:test";
import { rawRequest } from "../src/raw-request";

describe("raw request safety", () => {
  test("rejects absolute and protocol-relative URLs", async () => {
    await expect(rawRequest("token", { method: "GET", path: "https://example.com" })).rejects.toThrow(
      "single /",
    );
    await expect(rawRequest("token", { method: "GET", path: "//example.com" })).rejects.toThrow(
      "single /",
    );
  });

  test("pins the Asana origin and refuses redirects", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fakeFetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify({ data: { gid: "1" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await rawRequest("opaque-token", {
      method: "GET",
      path: "/tasks/1",
      query: { opt_fields: "name" },
      fetchImpl: fakeFetch,
    });
    expect(result).toEqual({ data: { gid: "1" } });
    expect(capturedUrl).toBe("https://app.asana.com/api/1.0/tasks/1?opt_fields=name");
    expect(capturedInit?.redirect).toBe("error");
    expect((capturedInit?.headers as Record<string, string>).Authorization).toBe("Bearer opaque-token");
  });
});
