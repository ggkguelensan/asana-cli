import { describe, expect, test } from "bun:test";
import {
  assertSupportedRuntimePlatform,
  SUPPORTED_RUNTIME_PLATFORMS,
} from "../src/platform-support";

describe("runtime platform support", () => {
  test("accepts only the documented native runtime platforms", () => {
    expect(SUPPORTED_RUNTIME_PLATFORMS).toEqual(["darwin", "linux"]);
    expect(assertSupportedRuntimePlatform("darwin")).toBe("darwin");
    expect(assertSupportedRuntimePlatform("linux")).toBe("linux");
  });

  test("fails with a stable machine-readable error outside macOS and Linux", () => {
    try {
      assertSupportedRuntimePlatform("win32");
      throw new Error("Expected unsupported platform failure");
    } catch (error: unknown) {
      expect(error).toMatchObject({
        code: "unsupported-platform",
        exitCode: 2,
        message: "This asana-cli release supports native macOS and Linux runtimes only.",
      });
    }
  });
});
