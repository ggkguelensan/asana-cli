import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { lstat, readFile, writeFile } from "node:fs/promises";
import {
  allFilesystemEntries,
  binary,
  createFixture,
  decodeJson,
  record,
  removeFixture,
  runBinary,
  successfulJson,
  text,
  wireError,
} from "./harness";

describe.skipIf(!existsSync(binary))("black-box integration adapters", () => {
  test("discovers and plans every embedded client in both isolated scopes", async () => {
    const fixture = await createFixture("asana-cli-black-box-adapters-");
    try {
      const catalog = record(
        await successfulJson(fixture, ["integrations", "list", "--compact"]),
        "integration catalog",
      );
      expect(catalog).toMatchObject({
        schema: "asana-cli.integration-bundle.v1",
        runtime: {
          platform: process.platform,
          architecture: process.arch,
        },
      });
      const clients = record(catalog.clients, "integration clients");
      const clientNames = Object.keys(clients).sort();
      expect(clientNames).toEqual([
        "claude-code",
        "codex",
        "cursor",
        "gemini-cli",
        "generic-agent-skills",
        "github-copilot",
        "kimi-code",
        "opencode",
        "pi",
      ]);

      for (const client of clientNames) {
        const policy = await runBinary(
          fixture,
          ["integrations", "policy", client],
        );
        expect(policy, client).toMatchObject({
          exitCode: 0,
          stderr: "",
          timedOut: false,
        });
        expect(policy.stdout, client).toContain("## Never auto-allow");
        expect(policy.stdout, client).toContain(
          "asana-cli integrations install --apply",
        );

        for (const scope of ["project", "user"] as const) {
          const target = ["--client", client, "--scope", scope, "--compact"];
          const detection = record(await successfulJson(
            fixture,
            ["integrations", "detect", ...target],
          ), `${client} ${scope} detection`);
          expect(detection.discovery, `${client} ${scope}`).toBe("absent");
          expect(record(detection.inspection, `${client} ${scope} inspection`).state)
            .toBe("absent");

          const status = record(await successfulJson(
            fixture,
            ["integrations", "status", ...target],
          ), `${client} ${scope} status`);
          expect(status.state, `${client} ${scope}`).toBe("absent");

          const plan = record(await successfulJson(
            fixture,
            [
              "integrations",
              "install",
              "--client",
              client,
              "--scope",
              scope,
              "--dry-run",
              "--compact",
            ],
          ), `${client} ${scope} install plan`);
          expect(plan, `${client} ${scope}`).toMatchObject({
            action: "install",
            current_state: "absent",
          });
          expect(record(plan.target, `${client} ${scope} target`).scope).toBe(scope);
          expect(Array.isArray(plan.changes), `${client} ${scope} changes`).toBe(true);
          expect((plan.changes as unknown[]).length, `${client} ${scope} changes`).toBeGreaterThan(0);
        }
      }
    } finally {
      await removeFixture(fixture);
    }
  }, 60_000);

  test("applies one complete managed lifecycle without touching repository instructions", async () => {
    const fixture = await createFixture("asana-cli-black-box-lifecycle-");
    const sentinel = "BLACK_BOX_AGENTS_SENTINEL_182736\n";
    const fakePat = "BLACK_BOX_DOCTOR_PAT_918273";
    try {
      await writeFile(`${fixture.project}/AGENTS.md`, sentinel);
      const target = ["--client", "codex", "--scope", "project", "--compact"];

      const doctorInvocation = await runBinary(
        fixture,
        [
          "integrations",
          "doctor",
          "--client",
          "codex",
          "--scope",
          "project",
          "--skip-credential-store",
          "--auto-allow",
          "Bash(asana-cli *)",
          "--compact",
        ],
        { env: { ASANA_ACCESS_TOKEN: fakePat } },
      );
      expect(doctorInvocation).toMatchObject({
        exitCode: 0,
        stderr: "",
        timedOut: false,
      });
      expect(doctorInvocation.stdout).not.toContain(fakePat);
      expect(doctorInvocation.stdout).not.toContain("Bash(asana-cli *)");
      const doctor = record(
        decodeJson(doctorInvocation.stdout, "integration doctor"),
        "integration doctor",
      );
      expect(record(doctor.credential_sources, "credential sources")).toMatchObject({
        effective: "ASANA_ACCESS_TOKEN",
        os_credential_store: { status: "not-checked" },
      });
      expect(record(doctor.permission_review, "permission review").status).toBe(
        "unsafe",
      );

      const installed = record(await successfulJson(
        fixture,
        ["integrations", "install", "--client", "codex", "--scope", "project", "--apply", "--compact"],
      ), "integration installation");
      expect(record(installed.plan, "install plan").action).toBe("install");
      expect(record(installed.execution, "install execution").action).toBe("install");
      expect(await readFile(`${fixture.project}/AGENTS.md`, "utf8")).toBe(sentinel);

      const status = record(await successfulJson(
        fixture,
        ["integrations", "status", ...target],
      ), "managed integration status");
      expect(status.state).toBe("managed");
      const installationDirectory = text(
        record(status.target, "managed target").installation_directory,
        "installation directory",
      );
      for (const path of [installationDirectory, ...await allFilesystemEntries(installationDirectory)]) {
        const stats = await lstat(path);
        expect(stats.mode & 0o077, path).toBe(0);
      }

      const detected = record(await successfulJson(
        fixture,
        ["integrations", "detect", ...target],
      ), "managed integration detection");
      expect(detected.discovery).toBe("found");
      expect(record(detected.inspection, "managed inspection").state).toBe("managed");

      const diff = record(await successfulJson(
        fixture,
        ["integrations", "diff", ...target],
      ), "managed integration diff");
      expect(diff).toMatchObject({ action: "none", current_state: "managed" });
      expect(diff.changes).toEqual([]);

      const update = record(await successfulJson(
        fixture,
        [
          "integrations",
          "update",
          "--client",
          "codex",
          "--scope",
          "project",
          "--dry-run",
          "--compact",
        ],
      ), "managed integration update plan");
      expect(update).toMatchObject({ action: "none", current_state: "managed" });

      const denied = await runBinary(
        fixture,
        [
          "integrations",
          "update",
          "--client",
          "codex",
          "--scope",
          "project",
          "--apply",
        ],
        { env: { ASANA_CLI_AGENT: "1" } },
      );
      expect(denied).toMatchObject({ exitCode: 2, stdout: "", timedOut: false });
      expect(wireError(decodeJson(denied.stderr, "agent lifecycle denial")).code)
        .toBe("policy-denied");
      expect(record(await successfulJson(
        fixture,
        ["integrations", "status", ...target],
      ), "status after denied update").state).toBe("managed");

      const uninstallPlan = record(await successfulJson(
        fixture,
        [
          "integrations",
          "uninstall",
          "--client",
          "codex",
          "--scope",
          "project",
          "--dry-run",
          "--compact",
        ],
      ), "uninstall plan");
      expect(uninstallPlan).toMatchObject({
        action: "uninstall",
        current_state: "managed",
      });
      const uninstalled = record(await successfulJson(
        fixture,
        [
          "integrations",
          "uninstall",
          "--client",
          "codex",
          "--scope",
          "project",
          "--apply",
          "--compact",
        ],
      ), "integration uninstall");
      expect(record(uninstalled.execution, "uninstall execution").action).toBe(
        "uninstall",
      );
      expect(record(await successfulJson(
        fixture,
        ["integrations", "status", ...target],
      ), "absent integration status").state).toBe("absent");
      expect(await readFile(`${fixture.project}/AGENTS.md`, "utf8")).toBe(sentinel);
    } finally {
      await removeFixture(fixture);
    }
  }, 30_000);
});
