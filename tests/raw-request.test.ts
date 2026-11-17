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

test("raw requests block known credentials before calling fetch", async () => {
  let called = false;
  const token = "OUTBOUND_REST_CREDENTIAL_CANARY";
  await expect(rawRequest(token, {
    method: "POST", path: "/tasks", data: { data: { notes: token } },
    fetchImpl: async () => { called = true; return Response.json({ data: {} }); },
  })).rejects.toThrow("Request data contains a credential");
  expect(called).toBe(false);
});

test("inline query and path credentials are blocked before calling fetch", async () => {
  const token = "INLINE_REST_CREDENTIAL_CANARY";
  const encoded = [...token].map((character) => `%${character.charCodeAt(0).toString(16)}`).join("");
  for (const path of [`/tasks?name=${token}`, `/tasks?name=${encoded}`, `/tasks/${token}`, `/tasks/${encoded}`]) {
    let called = false;
    await expect(rawRequest(token, {
      method: "POST", path,
      fetchImpl: async () => { called = true; return Response.json({ data: {} }); },
    })).rejects.toThrow("Request data contains a credential");
    expect(called).toBe(false);
  }
});

test("malformed percent encoding fails as a validation error before fetch", async () => {
  let called = false;
  await expect(rawRequest("TEST_REST_TOKEN", {
    method: "GET", path: "/tasks/%ZZ",
    fetchImpl: async () => { called = true; return Response.json({ data: {} }); },
  })).rejects.toMatchObject({ code: "validation" });
  expect(called).toBe(false);
});
