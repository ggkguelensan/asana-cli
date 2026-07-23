import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  AGENT_ACTION_MINIMUM_CLI_VERSION,
  AGENT_ACTION_NAMES,
  AGENT_ACTIONS,
  AGENT_OPERATION_APPLY_MINIMUM_CLI_VERSION,
  agentActionDescriptorSchema,
  createAgentActionResult,
  type AgentActionName,
} from "../src/agent-contract";
import { taskPatchSchema } from "../src/agent-action-schemas";
import { AGENT_MANIFEST } from "../src/agent-mode";
import { runCli } from "../src/cli";
import { AGENT_ERROR_SCHEMA_ID } from "../src/errors";
import { jsonObjectSchema } from "../src/schemas";
import { secureAgentEnvelope } from "../src/security";
import {
  AGENT_PROTOCOL_COMPATIBILITY,
  AGENT_PROTOCOL_UPGRADE_GUIDANCE,
  AGENT_PROTOCOL_VERSION,
  CLI_VERSION,
} from "../src/version";

const publishedActionSchema = z.strictObject({
  descriptor: agentActionDescriptorSchema,
  input: jsonObjectSchema,
  output: jsonObjectSchema,
});

const protocolCompatibilitySchema = z.strictObject({
  minimum: z.literal(AGENT_PROTOCOL_COMPATIBILITY.minimum),
  maximum: z.literal(AGENT_PROTOCOL_COMPATIBILITY.maximum),
});

const unsupportedProtocolSchema = z.strictObject({
  reason: z.literal(AGENT_PROTOCOL_UPGRADE_GUIDANCE.reason),
  supported_protocol: protocolCompatibilitySchema,
  required_action: z.literal(AGENT_PROTOCOL_UPGRADE_GUIDANCE.required_action),
});

const schemaCatalogSchema = z.strictObject({
  agent_protocol_version: z.literal(AGENT_PROTOCOL_VERSION),
  cli_version: z.literal(CLI_VERSION),
  schema: z.literal("asana-cli.agent.schema-catalog.v2"),
  protocol_compatibility: protocolCompatibilitySchema,
  unsupported_protocol: unsupportedProtocolSchema,
  error_schema_id: z.literal(AGENT_ERROR_SCHEMA_ID),
  error_schema: jsonObjectSchema,
  actions: z.array(publishedActionSchema),
});

const singleActionSchema = z.strictObject({
  agent_protocol_version: z.literal(AGENT_PROTOCOL_VERSION),
  cli_version: z.literal(CLI_VERSION),
  schema: z.literal("asana-cli.agent.action-schema.v2"),
  error_schema_id: z.literal(AGENT_ERROR_SCHEMA_ID),
  protocol_compatibility: protocolCompatibilitySchema,
  unsupported_protocol: unsupportedProtocolSchema,
  error_schema: jsonObjectSchema,
  action: publishedActionSchema,
});

const jsonSchemaBoundary = z.custom<Parameters<typeof z.fromJSONSchema>[0]>(
  (value) => typeof value === "object" && value !== null,
  "Expected a JSON Schema object",
);

function withoutUnsupportedNot(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUnsupportedNot);
  if (!value || typeof value !== "object") return value;
  const record = z.looseObject({}).parse(value);
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => key !== "not")
      .map(([key, entry]) => [key, withoutUnsupportedNot(entry)]),
  );
}

interface DriftFixture {
  valid: unknown;
  invalid: unknown;
}

const operationId = "00000000-0000-4000-8000-000000000001";

const driftFixtures = {
  status: { valid: {}, invalid: { unexpected: true } },
  "operation-status": { valid: { operation_id: operationId }, invalid: { operation_id: "invalid" } },
  "git-current": { valid: { git_current: true }, invalid: { git_current: false } },
  "repository-asana": { valid: { repository_asana: true }, invalid: { repository_asana: false } },
  "repository-context": { valid: { repository_context: true }, invalid: { repository_context: false } },
  "git-current-candidates": {
    valid: { workspace_gid: "1200", all_assignees: true, completed: false, field_gid: "900" },
    invalid: { workspace_gid: "1200", query: "Acme/widgets" },
  },
  "my-tasks": { valid: {}, invalid: { limit: 0 } },
  "get-task": { valid: { task_gid: "123" }, invalid: { task_gid: "not-a-gid" } },
  "list-comments": { valid: { task_gid: "123" }, invalid: { max_results: 501 } },
  "search-tasks": { valid: { query: "git-123" }, invalid: { query: "" } },
  "find-git": { valid: { query: "git-123" }, invalid: { unexpected: true } },
  "prepare-task-update": {
    valid: { task_gid: "123", patch: { completed: true } },
    invalid: { task_gid: "invalid", patch: { completed: true } },
  },
  "prepare-comment": {
    valid: { task_gid: "123", text: "Comment" },
    invalid: { task_gid: "123", text: "" },
  },
  apply: { valid: { operation_id: operationId }, invalid: { operation_id: "invalid" } },
} satisfies Record<AgentActionName, DriftFixture>;

describe("agent capability and schema catalog", () => {
  test("describes every current action from one registry", () => {
    expect(AGENT_ACTION_NAMES).toEqual([
      "status",
      "operation-status",
      "my-tasks",
      "git-current",
      "repository-asana",
      "repository-context",
      "git-current-candidates",
      "get-task",
      "list-comments",
      "search-tasks",
      "find-git",
      "prepare-task-update",
      "prepare-comment",
      "apply",
    ]);
    expect(AGENT_MANIFEST.actions).toHaveLength(AGENT_ACTION_NAMES.length);
    expect(AGENT_MANIFEST.safe_commands).toEqual([
      "asana-cli agent status",
      "asana-cli agent operation status UUID",
      "asana-cli agent my-tasks",
      "asana-cli agent context --git-current",
      "asana-cli agent context --repository-asana",
      "asana-cli agent context --repository-context",
      "asana-cli agent context --git-current-candidates",
      "asana-cli agent get-task",
      "asana-cli agent list-comments",
      "asana-cli agent search-tasks",
      "asana-cli agent find-git",
      "asana-cli agent prepare-task-update",
      "asana-cli agent prepare-comment",
    ]);
    expect(Object.keys(AGENT_MANIFEST.guarded_commands)).toEqual([
      "asana-cli agent apply",
    ]);
    expect(AGENT_MANIFEST.forbidden_commands).toEqual([
      "asana-cli agent raw",
      "asana-cli agent api",
      "asana-cli auth pat set",
      "asana-cli auth pat delete",
      "asana-cli context ...",
      "asana-cli integrations install --apply",
      "asana-cli integrations update --apply",
      "asana-cli integrations uninstall --apply",
    ]);
    expect(AGENT_MANIFEST.deprecated_commands).toEqual({
      "asana-cli agent apply-task-update": {
        reason: "legacy-plan-apply-removed",
        replacement: "asana-cli agent apply --operation-id UUID",
        replacement_action: "apply",
        required_input: { operation_id: "UUID" },
      },
      "asana-cli agent apply-comment": {
        reason: "legacy-plan-apply-removed",
        replacement: "asana-cli agent apply --operation-id UUID",
        replacement_action: "apply",
        required_input: { operation_id: "UUID" },
      },
    });
    for (const descriptor of AGENT_MANIFEST.actions) {
      const minimum = descriptor.action === "repository-context"
        ? "0.5.0"
        : ["operation-status", "prepare-task-update", "prepare-comment", "apply"]
          .includes(descriptor.action)
        ? AGENT_OPERATION_APPLY_MINIMUM_CLI_VERSION
        : AGENT_ACTION_MINIMUM_CLI_VERSION;
      expect(agentActionDescriptorSchema.parse(descriptor)).toMatchObject({
        minimum_cli_version: minimum,
      });
    }
  });

  test("publishes the git-current action as a no-input local read command", () => {
    expect(AGENT_ACTIONS["git-current"].descriptor).toMatchObject({
      action: "git-current",
      operation: "git.context.current",
      effect: "read",
      approval: "none",
      limits: { max_input_bytes: 0, max_result_items: 16 },
      command: ["context", "--git-current"],
    });
    expect(AGENT_MANIFEST.actions).toContainEqual(AGENT_ACTIONS["git-current"].descriptor);
  });

  test("publishes the trusted repository mapping as a one-result local read with a strict public projection", async () => {
    expect(AGENT_ACTIONS["repository-asana"].descriptor).toMatchObject({
      action: "repository-asana",
      operation: "repository.context.asana",
      effect: "read",
      approval: "none",
      limits: { max_input_bytes: 0, max_result_items: 1 },
      command: ["context", "--repository-asana"],
    });
    const publication = singleActionSchema.parse(
      (await runCli(["agent", "schema", "repository-asana"])).value,
    );
    const output = z.fromJSONSchema(jsonSchemaBoundary.parse(publication.action.output));
    const result = secureAgentEnvelope(createAgentActionResult("repository-asana", "read", {
      git: {
        remote: { host: "github.example" },
        repository: { owner: "Acme", name: "widgets" },
      },
      mapping: { workspace_gid: "1200" },
    }));
    expect(output.safeParse(result).success).toBe(true);
    expect(() => createAgentActionResult("repository-asana", "read", {
      git: {
        remote: { host: "github.example" },
        repository: { owner: "Acme", name: "widgets" },
      },
      mapping: { workspace_gid: "1200", config_path: "PRIVATE_PATH_CANARY" },
    })).toThrow();
  });

  test("publishes repository context as a bounded local read and rejects source-location leakage", async () => {
    expect(AGENT_ACTIONS["repository-context"].descriptor).toEqual(expect.objectContaining({
      action: "repository-context",
      operation: "repository.context.current",
      effect: "read",
      approval: "none",
      limits: { max_input_bytes: 0, max_result_items: 100 },
      minimum_cli_version: "0.5.0",
      command: ["context", "--repository-context"],
    }));
    const publication = singleActionSchema.parse(
      (await runCli(["agent", "schema", "repository-context"])).value,
    );
    const output = z.fromJSONSchema(jsonSchemaBoundary.parse(publication.action.output));
    const data = {
      schema: "asana-cli.repository-context.v1",
      revision: 7,
      digest: `sha256:${"a".repeat(64)}`,
      workspace_gid: "100",
      projects: [{ alias: "platform", project_gid: "200" }],
      sections: [],
      custom_fields: [],
      tasks: [{
        project_alias: "platform",
        alias: "dev-012--repository-context",
        qualified_alias: "task:platform/dev-012--repository-context",
        task_gid: "500",
      }],
    };
    expect(output.safeParse(secureAgentEnvelope(createAgentActionResult(
      "repository-context",
      "read",
      data,
    ))).success).toBe(true);
    expect(() => createAgentActionResult("repository-context", "read", {
      ...data,
      manifest_path: "PRIVATE_MANIFEST_PATH_CANARY",
    })).toThrow();
  });

  test("publishes the bounded authenticated candidate command separately from local Git context", async () => {
    expect(AGENT_ACTIONS["git-current-candidates"].descriptor).toMatchObject({
      action: "git-current-candidates",
      operation: "git.context.current.candidates",
      effect: "read",
      approval: "none",
      limits: { max_input_bytes: 0, max_result_items: 20 },
      command: ["context", "--git-current-candidates"],
    });
    const publication = singleActionSchema.parse(
      (await runCli(["agent", "schema", "git-current-candidates"])).value,
    );
    expect(publication.action.descriptor).toEqual(AGENT_ACTIONS["git-current-candidates"].descriptor);
    const output = z.fromJSONSchema(jsonSchemaBoundary.parse(publication.action.output));
    const result = secureAgentEnvelope(createAgentActionResult("git-current-candidates", "read", {
      candidates: [{
        task: { gid: "123", name: "Candidate" },
        matches: [{ kind: "repository", fields: ["name"] }],
      }],
      meta: {
        workspace_gid: "1200",
        mine: true,
        count: 1,
        max_candidates: 20,
        truncated: false,
        truncation_reasons: [],
      },
    }));
    expect(output.safeParse(result).success).toBe(true);
  });

  test("publishes the full catalog and one action without authentication", async () => {
    const catalogResult = await runCli(["agent", "schema"]);
    const catalog = schemaCatalogSchema.parse(catalogResult.value);
    expect(catalog.actions.map((entry) => entry.descriptor.action)).toEqual(AGENT_ACTION_NAMES);
    expect(catalog.protocol_compatibility).toEqual(AGENT_PROTOCOL_COMPATIBILITY);
    expect(catalog.unsupported_protocol).toEqual(AGENT_PROTOCOL_UPGRADE_GUIDANCE);

    const actionResult = await runCli(["agent", "schema", "my-tasks"]);
    const actionPublication = singleActionSchema.parse(actionResult.value);
    expect(actionPublication.protocol_compatibility).toEqual(catalog.protocol_compatibility);
    expect(actionPublication.unsupported_protocol).toEqual(catalog.unsupported_protocol);
    const action = actionPublication.action;
    expect(action.descriptor.action).toBe("my-tasks");
    expect(action.input.$id).toBe(action.descriptor.input_schema);
    expect(action.output.$id).toBe(action.descriptor.output_schema);
  });

  test("keeps published input JSON Schema aligned with runtime Zod schemas", async () => {
    const catalog = schemaCatalogSchema.parse((await runCli(["agent", "schema"])).value);
    const publications = new Map(
      catalog.actions.map((publication) => [publication.descriptor.action, publication]),
    );

    for (const action of AGENT_ACTION_NAMES) {
      const publication = publications.get(action);
      expect(publication).toBeDefined();
      // z.fromJSONSchema does not implement standard `not`; its exact rule is asserted below.
      const convertibleInput = withoutUnsupportedNot(publication?.input);
      const publishedInput = z.fromJSONSchema(jsonSchemaBoundary.parse(convertibleInput));
      const runtimeInput = AGENT_ACTIONS[action].inputSchema;
      const fixture = driftFixtures[action];
      expect(runtimeInput.safeParse(fixture.valid).success).toBe(true);
      expect(publishedInput.safeParse(fixture.valid).success).toBe(true);
      expect(runtimeInput.safeParse(fixture.invalid).success).toBe(false);
      expect(publishedInput.safeParse(fixture.invalid).success).toBe(false);
    }
  });

  test("publishes the actual secure stdout envelope as the output schema", async () => {
    const publication = singleActionSchema.parse(
      (await runCli(["agent", "schema", "my-tasks"])).value,
    );
    const publishedOutput = z.fromJSONSchema(
      jsonSchemaBoundary.parse(publication.action.output),
    );
    const result = createAgentActionResult("my-tasks", "read", {
      data: [],
      meta: { count: 0 },
    });
    const wireEnvelope = secureAgentEnvelope(result);
    expect(publishedOutput.safeParse(wireEnvelope).success).toBe(true);
    expect(z.looseObject({
      agent_protocol_version: z.literal(AGENT_PROTOCOL_VERSION),
      cli_version: z.literal(CLI_VERSION),
      schema: z.literal("asana-cli.agent.v2"),
      content_trust: z.literal("external-untrusted"),
      result: z.looseObject({
        operation: z.literal("tasks.mine"),
        effect: z.literal("read"),
        policy: z.literal("read"),
      }),
      _meta: z.looseObject({ security: z.looseObject({}) }),
    }).parse(wireEnvelope).result.operation).toBe("tasks.mine");
  });

  test("preserves v0.2 read defaults and strict logical prepare inputs", () => {
    expect(AGENT_ACTIONS["my-tasks"].inputSchema.parse({})).toEqual({
      completed: "false",
      limit: 50,
      paginate: false,
      max_results: 100,
    });
    expect(AGENT_ACTIONS["get-task"].inputSchema.parse({ task_gid: "123" })).toEqual({
      task_gid: "123",
      include_content: false,
    });
    expect(AGENT_ACTIONS["prepare-comment"].inputSchema.parse({
      task_gid: "123",
      text: "Comment",
    })).toEqual({ task_gid: "123", text: "Comment" });
    expect(AGENT_ACTIONS["prepare-task-update"].inputSchema.safeParse({
      task_gid: "123",
      patch: {},
    }).success).toBe(false);
  });

  test("publishes JSON Schema metadata for runtime object refinements", async () => {
    const publication = singleActionSchema.parse(
      (await runCli(["agent", "schema", "prepare-task-update"])).value,
    );
    const patchSchema = z.looseObject({
      properties: z.looseObject({
        patch: z.looseObject({
          minProperties: z.literal(1),
          not: z.strictObject({
            required: z.tuple([z.literal("due_on"), z.literal("due_at")]),
            properties: z.strictObject({
              due_on: z.strictObject({ type: z.literal("string") }),
              due_at: z.strictObject({ type: z.literal("string") }),
            }),
          }),
          properties: z.looseObject({
            custom_fields: z.looseObject({ maxProperties: z.literal(50) }),
          }),
        }),
      }),
    }).parse(publication.action.input);
    expect(patchSchema.properties.patch.minProperties).toBe(1);
    expect(patchSchema.properties.patch.not.required).toEqual(["due_on", "due_at"]);
    expect(patchSchema.properties.patch.not.properties).toEqual({
      due_on: { type: "string" },
      due_at: { type: "string" },
    });
    expect(patchSchema.properties.patch.properties.custom_fields.maxProperties).toBe(50);

    const dueRule = patchSchema.properties.patch.not;
    const rejectedByPublishedNot = (patch: Record<string, unknown>): boolean =>
      dueRule.required.every((field) => Object.hasOwn(patch, field)) &&
      Object.keys(dueRule.properties).every((field) => typeof patch[field] === "string");
    const dueFixtures: Array<{ patch: Record<string, unknown>; valid: boolean }> = [
      { patch: { due_on: "2026-07-15", due_at: "2026-07-15T10:00:00Z" }, valid: false },
      { patch: { due_on: null, due_at: "2026-07-15T10:00:00Z" }, valid: true },
      { patch: { due_on: "2026-07-15", due_at: null }, valid: true },
      { patch: { due_on: null, due_at: null }, valid: true },
      { patch: { due_on: "2026-07-15" }, valid: true },
    ];
    for (const fixture of dueFixtures) {
      expect(taskPatchSchema.safeParse(fixture.patch).success).toBe(fixture.valid);
      expect(rejectedByPublishedNot(fixture.patch)).toBe(!fixture.valid);
    }
  });

  test("rejects an unknown schema action before authentication", async () => {
    await expect(runCli(["agent", "schema", "unknown-action"]))
      .rejects.toThrow("Unknown agent action: unknown-action");
  });
});
