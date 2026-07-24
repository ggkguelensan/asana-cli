import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  array,
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

describe.skipIf(!existsSync(binary))("black-box public protocol", () => {
  test("publishes one self-consistent version, help, manifest, and schema for every action", async () => {
    const fixture = await createFixture("asana-cli-black-box-contract-");
    try {
      const versionResult = await runBinary(fixture, ["--version"]);
      expect(versionResult).toMatchObject({ exitCode: 0, stderr: "", timedOut: false });
      const version = versionResult.stdout.trim();
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);

      const help = await runBinary(fixture, ["--help"]);
      expect(help).toMatchObject({ exitCode: 0, stderr: "", timedOut: false });
      expect(help.stdout).toContain(`asana-cli ${version}`);
      for (const section of [
        "AUTHENTICATION",
        "LOCAL DEVELOPER CONTEXT",
        "AGENT CLIENTS",
        "INTEGRATIONS",
        "TASKS",
        "NODE-ASANA PRIMITIVES",
        "RAW REST API",
      ]) {
        expect(help.stdout).toContain(section);
      }

      const capabilitiesText = await runBinary(
        fixture,
        ["agent", "capabilities", "--compact"],
      );
      expect(capabilitiesText).toMatchObject({
        exitCode: 0,
        stderr: "",
        timedOut: false,
      });
      expect(capabilitiesText.stdout).not.toContain("[REDACTED:CIRCULAR_REFERENCE]");
      const envelope = record(
        decodeJson(capabilitiesText.stdout, "agent capabilities"),
        "agent envelope",
      );
      expect(envelope).toMatchObject({
        cli_version: version,
        schema: "asana-cli.agent.v2",
        content_trust: "external-untrusted",
      });
      const manifest = record(envelope.result, "agent manifest");
      expect(manifest).toMatchObject({
        cli_version: version,
        protocol: "asana-cli-agent-v2",
        default_mode: "read-only",
      });
      const compatibility = record(
        manifest.protocol_compatibility,
        "protocol compatibility",
      );
      expect(record(
        record(manifest.unsupported_protocol, "unsupported protocol").supported_protocol,
        "supported protocol",
      )).toEqual(compatibility);

      const actions = array(manifest.actions, "manifest actions").map((value, index) =>
        record(value, `manifest action ${index}`)
      );
      expect(actions.length).toBeGreaterThanOrEqual(32);
      const names = actions.map((action) => text(action.action, "action name"));
      expect(new Set(names).size).toBe(names.length);

      for (const descriptor of actions) {
        const action = text(descriptor.action, "descriptor action");
        const schemaInvocation = await runBinary(
          fixture,
          ["agent", "schema", action, "--compact"],
        );
        expect(schemaInvocation).toMatchObject({
          exitCode: 0,
          stderr: "",
          timedOut: false,
        });
        expect(schemaInvocation.stdout).not.toContain("[REDACTED:CIRCULAR_REFERENCE]");
        const schemaEnvelope = record(
          decodeJson(schemaInvocation.stdout, `agent schema ${action}`),
          `${action} schema envelope`,
        );
        expect(schemaEnvelope.cli_version).toBe(version);
        const schemaDocument = record(schemaEnvelope.result, `${action} schema document`);
        expect(record(
          schemaDocument.unsupported_protocol,
          `${action} unsupported protocol`,
        ).supported_protocol).toEqual(compatibility);
        const publishedAction = record(schemaDocument.action, `${action} published action`);
        const publishedDescriptor = record(
          publishedAction.descriptor,
          `${action} descriptor`,
        );
        expect(publishedDescriptor).toEqual(descriptor);
        expect(record(publishedAction.input, `${action} input schema`).$id).toBe(
          descriptor.input_schema,
        );
        expect(record(publishedAction.output, `${action} output schema`).$id).toBe(
          descriptor.output_schema,
        );
      }
    } finally {
      await removeFixture(fixture);
    }
  }, 30_000);

  test("keeps static discovery usable without credentials or source files", async () => {
    const fixture = await createFixture("asana-cli-black-box-static-");
    try {
      const auth = await runBinary(fixture, ["auth"]);
      expect(auth).toMatchObject({ exitCode: 0, stderr: "", timedOut: false });
      expect(auth.stdout).toContain("Asana PAT setup");

      const apiClasses = array(record(
        await successfulJson(fixture, ["api", "list", "--compact"]),
        "API discovery",
      ).classes, "API class list");
      expect(apiClasses).toContain("TasksApi");
      expect(apiClasses).toContain("UsersApi");

      const docs = record(await successfulJson(
        fixture,
        ["api", "docs", "TasksApi", "getTask", "--compact"],
      ), "API documentation");
      expect(docs).toEqual({
        class: "TasksApi",
        method: "getTask",
        url: "https://github.com/Asana/node-asana/blob/master/docs/TasksApi.md#getTask",
      });
    } finally {
      await removeFixture(fixture);
    }
  });

  test("returns stable human and agent errors without contacting Asana", async () => {
    const fixture = await createFixture("asana-cli-black-box-errors-");
    const fakePat = "BLACK_BOX_FAKE_PAT_812734";
    const secretArgument = "BLACK_BOX_FORBIDDEN_SECRET_981273";
    try {
      const cases = [
        {
          args: ["definitely-not-a-command"],
          env: { ASANA_ACCESS_TOKEN: fakePat },
          expectedCode: "usage",
          expectedExit: 2,
        },
        {
          args: ["request", "TRACE", "/tasks"],
          env: { ASANA_ACCESS_TOKEN: fakePat },
          expectedCode: "usage",
          expectedExit: 2,
        },
        {
          args: ["request", "GET", "https://evil.invalid/tasks"],
          env: { ASANA_ACCESS_TOKEN: fakePat },
          expectedCode: "validation",
          expectedExit: 2,
        },
        {
          args: ["agent", "definitely-not-an-action"],
          env: { ASANA_ACCESS_TOKEN: fakePat },
          expectedCode: "usage",
          expectedExit: 2,
        },
        {
          args: ["context", "history"],
          env: { ASANA_CLI_AGENT: "1" },
          expectedCode: "policy-denied",
          expectedExit: 2,
        },
        {
          args: ["task", "update", "1200000000001", "--dry-run"],
          env: { ASANA_CLI_AGENT: "1" },
          expectedCode: "policy-denied",
          expectedExit: 2,
        },
        {
          args: [
            "agent",
            "apply",
            "--operation-id",
            "00000000-0000-4000-8000-000000000001",
          ],
          env: { ASANA_CLI_AGENT_POLICY: "read" },
          expectedCode: "policy-denied",
          expectedExit: 2,
        },
      ] as const;

      for (const scenario of cases) {
        const result = await runBinary(fixture, scenario.args, { env: scenario.env });
        expect(result).toMatchObject({
          exitCode: scenario.expectedExit,
          stdout: "",
          timedOut: false,
        });
        const payload = decodeJson(result.stderr, scenario.args.join(" "));
        expect(wireError(payload).code).toBe(scenario.expectedCode);
        expect(result.stderr).not.toContain(fakePat);
      }

      const forbidden = await runBinary(
        fixture,
        ["--version", "--token", secretArgument],
      );
      expect(forbidden).toMatchObject({ exitCode: 2, stdout: "", timedOut: false });
      expect(wireError(decodeJson(forbidden.stderr, "forbidden option")).code).toBe(
        "policy-denied",
      );
      expect(forbidden.stderr).not.toContain(secretArgument);

      const invalidInput = await runBinary(
        fixture,
        ["agent", "batch-tasks", "--input", "-"],
        {
          env: { ASANA_ACCESS_TOKEN: fakePat },
          stdin: "{\"unexpected\":true}",
        },
      );
      expect(invalidInput).toMatchObject({ exitCode: 2, stdout: "", timedOut: false });
      const invalidPayload = record(
        decodeJson(invalidInput.stderr, "invalid agent input"),
        "invalid agent envelope",
      );
      expect(invalidPayload.schema).toBe("asana-cli.agent.v2");
      expect(wireError(invalidPayload).code).toBe("validation");
      expect(invalidInput.stderr).not.toContain(fakePat);
    } finally {
      await removeFixture(fixture);
    }
  });
});
