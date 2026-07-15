import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  apiClassNames,
  apiMethodNames,
  collectPages,
  createClient,
  invokeApiMethod,
  normalizeSdkResult,
} from "../src/sdk";

describe("node-asana boundary", () => {
  test("lists generated API classes while hiding WithHttpInfo methods", () => {
    expect(apiClassNames()).toContain("TasksApi");
    expect(apiMethodNames("TasksApi")).toContain("getTask");
    expect(apiMethodNames("TasksApi").some((name) => name.endsWith("WithHttpInfo"))).toBe(false);
  });

  test("forbids invoking a WithHttpInfo method", async () => {
    await expect(
      invokeApiMethod(createClient("SDK_TEST_CANARY"), "TasksApi", "getTaskWithHttpInfo", []),
    ).rejects.toThrow("Unknown method");
  });

  test("normalizes Collection without serializing its API client", () => {
    const collection = {
      data: [{ gid: "1" }],
      _response: { next_page: { offset: "next" } },
      _apiClient: { authentications: { token: { accessToken: "COLLECTION_CANARY" } } },
      nextPage: async () => ({ data: null }),
    };
    const normalized = normalizeSdkResult(collection);
    expect(normalized).toEqual({ data: [{ gid: "1" }], next_page: { offset: "next" } });
    expect(JSON.stringify(normalized)).not.toContain("COLLECTION_CANARY");
  });

  test("collects pagination through the explicit data boundary", async () => {
    const second = {
      data: [{ gid: "2" }],
      _response: { next_page: null },
      nextPage: async () => ({ data: null }),
    };
    const first = {
      data: [{ gid: "1" }],
      _response: { next_page: { offset: "next" } },
      nextPage: async () => second,
    };
    expect(await collectPages(first, true, 10, z.looseObject({ gid: z.string() }))).toEqual({
      data: [{ gid: "1" }, { gid: "2" }],
      next_page: null,
    });
  });
});
