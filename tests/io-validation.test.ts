import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { readJsonInput } from "../src/io";
import { parseExternalData, taskSchema } from "../src/schemas";
import { collectPages } from "../src/sdk";

describe("Zod I/O boundaries", () => {
  test("infers typed JSON only after schema validation", async () => {
    const schema = z.strictObject({ task_gid: z.string(), completed: z.boolean() });
    const input = await readJsonInput(
      '{"task_gid":"123","completed":true}',
      "--data",
      schema,
    );
    expect(input.task_gid).toBe("123");
    expect(input.completed).toBe(true);
  });

  test("rejects unknown fields at a strict JSON boundary", async () => {
    const schema = z.strictObject({ task_gid: z.string() });
    await expect(
      readJsonInput('{"task_gid":"123","unexpected":true}', "--data", schema),
    ).rejects.toThrow("Unrecognized key");
  });

  test("rejects malformed Asana envelopes", () => {
    expect(() => parseExternalData({ data: { name: "missing gid" } }, taskSchema, "test"))
      .toThrow("Invalid response data");
  });

  test("validates every item crossing a paginated SDK boundary", async () => {
    const collection = {
      data: [{ gid: "1" }, { name: "missing gid" }],
      _response: { next_page: null },
      nextPage: async () => ({ data: null }),
    };
    await expect(collectPages(collection, true, 10, taskSchema, "test collection"))
      .rejects.toThrow("Invalid response data");
  });
});
