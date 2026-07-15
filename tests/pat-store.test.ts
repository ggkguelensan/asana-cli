import { describe, expect, test } from "bun:test";
import { patFromStdin, resolvePatWithSource, validatePat } from "../src/pat-store";

describe("PAT resolution", () => {
  test("prefers ASANA_ACCESS_TOKEN and preserves opaque characters", async () => {
    const result = await resolvePatWithSource({
      ASANA_ACCESS_TOKEN: "opaque .*+[] token",
      ASANA_PAT: "fallback",
    });
    expect(result).toEqual({ pat: "opaque .*+[] token", source: "ASANA_ACCESS_TOKEN" });
  });

  test("strips only the stdin line ending", () => {
    expect(patFromStdin("opaque-token\r\n")).toBe("opaque-token");
  });

  test("rejects header injection", () => {
    expect(() => validatePat("token\nInjected: value")).toThrow("line breaks");
  });
});
