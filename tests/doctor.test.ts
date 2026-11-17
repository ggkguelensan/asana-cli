import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/args";
import { runDoctorCommand } from "../src/doctor";

describe("Asana CLI diagnostics", () => {
  test("offline diagnostics only probe local credentials and PATH", async () => {
    const calls: boolean[] = [];
    const result = await runDoctorCommand(parseArgs(["doctor", "--offline"]), {
      findOnPath: () => "/usr/local/bin/asana-cli",
      probeCredential: async (offline) => {
        calls.push(offline);
        return { configured: true, source: "ASANA_ACCESS_TOKEN", verified: false,
          status: "skipped", message: "Offline" };
      },
    });
    expect(calls).toEqual([true]);
    expect(result).toMatchObject({ status: "ok", offline: true,
      checks: [{ id: "runtime" }, { id: "path" }, { id: "authentication", status: "skipped" }] });
  });
  test("reports missing credentials and an unavailable installation", async () => {
    const result = await runDoctorCommand(parseArgs(["doctor"]), {
      findOnPath: () => null,
      probeCredential: async () => ({ configured: false, source: null, verified: false,
        status: "warning", message: "No credential" }),
    });
    expect(result).toMatchObject({ status: "warning", suggestions: [
      "Add the installation directory to PATH", "Run `asana-cli auth pat set`",
    ] });
  });
  test("propagates a failed Asana authentication check", async () => {
    const result = await runDoctorCommand(parseArgs(["doctor"]), {
      findOnPath: () => "/usr/local/bin/asana-cli",
      probeCredential: async () => ({ configured: true, source: "ASANA_PAT", verified: false,
        status: "error", message: "Rejected" }),
    });
    expect(result).toMatchObject({ status: "error" });
  });
});
