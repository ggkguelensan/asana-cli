import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { runAgentCommand } from "../src/agent-cli";
import { AGENT_MANIFEST } from "../src/agent-mode";
import { parseArgs } from "../src/args";
import { runCli } from "../src/cli";
import { MemoryOperationRepository } from "../src/operations/memory-repository";
import { createClient } from "../src/sdk";
import { secureAgentEnvelope } from "../src/security";
import {
  AGENT_PROTOCOL_COMPATIBILITY,
  AGENT_PROTOCOL_UPGRADE_GUIDANCE,
  AGENT_PROTOCOL_VERSION,
  CLI_VERSION,
} from "../src/version";

const agentRuntime = { operations: new MemoryOperationRepository() };

const protocolIdentitySchema = z.looseObject({
  agent_protocol_version: z.literal(AGENT_PROTOCOL_VERSION),
  cli_version: z.literal(CLI_VERSION),
});

const compatibleEnvelopeSchema = protocolIdentitySchema.extend({
  schema: z.literal("asana-cli.agent.v2"),
  content_trust: z.literal("external-untrusted"),
  result: z.unknown(),
  _meta: z.looseObject({
    security: z.looseObject({
      untrusted_content: z.boolean(),
    }),
  }),
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

const compatibleManifestSchema = protocolIdentitySchema.extend({
  protocol_compatibility: protocolCompatibilitySchema,
  unsupported_protocol: unsupportedProtocolSchema,
  protocol: z.literal("asana-cli-agent-v2"),
  default_mode: z.literal("read-only"),
  invocation: z.string(),
  safe_commands: z.array(z.string()),
  guarded_commands: z.record(z.string(), z.string()),
  forbidden_commands: z.array(z.string()),
  output_security: z.looseObject({}),
});

describe("agent protocol compatibility", () => {
  test("publishes one protocol identity in manifest and capabilities", async () => {
    const expectedManifest = compatibleManifestSchema.parse(AGENT_MANIFEST);
    expect(expectedManifest).toMatchObject({
      agent_protocol_version: AGENT_PROTOCOL_VERSION,
      cli_version: CLI_VERSION,
      protocol_compatibility: AGENT_PROTOCOL_COMPATIBILITY,
      unsupported_protocol: AGENT_PROTOCOL_UPGRADE_GUIDANCE,
    });

    for (const alias of ["manifest", "capabilities"]) {
      const result = await runCli(["agent", alias]);
      expect(compatibleManifestSchema.parse(result.value)).toEqual(expectedManifest);
    }
  });

  test("adds protocol identity without removing legacy envelope fields", () => {
    const envelope = compatibleEnvelopeSchema.parse(
      secureAgentEnvelope({ data: { name: "external task" } }),
    );
    expect(envelope.agent_protocol_version).toBe(AGENT_PROTOCOL_VERSION);
    expect(envelope.cli_version).toBe(CLI_VERSION);
    expect(envelope.schema).toBe("asana-cli.agent.v2");
    expect(envelope.content_trust).toBe("external-untrusted");
    expect(envelope._meta.security.untrusted_content).toBe(true);
  });

  test("keeps the minimal agent status response free of email", async () => {
    let requestedUrl: URL | undefined;
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        requestedUrl = new URL(request.url);
        return Response.json({
          data: {
            gid: "123",
            name: "Developer",
            email: "developer@example.com",
            workspaces: [{ gid: "456", name: "Workspace" }],
          },
        });
      },
    });
    try {
      const client = createClient("AGENT_STATUS_TEST_TOKEN");
      client.basePath = new URL("/api/1.0", server.url).toString().replace(/\/$/, "");
      const result = z.looseObject({
        operation: z.literal("auth.status"),
        data: z.looseObject({
          authenticated: z.literal(true),
          user: z.looseObject({
            gid: z.string(),
            name: z.string().optional(),
            workspaces: z.array(z.looseObject({ gid: z.string() })).optional(),
          }),
        }),
      }).parse(await runAgentCommand(client, parseArgs(["agent", "status"]), agentRuntime));
      expect(result.data.user).toEqual({
        gid: "123",
        name: "Developer",
        workspaces: [{ gid: "456", name: "Workspace" }],
      });
      expect(result.data.user).not.toHaveProperty("email");
      expect(requestedUrl?.searchParams.get("opt_fields")).not.toContain("email");
      expect(requestedUrl?.searchParams.get("opt_fields")).not.toContain("photo");
    } finally {
      server.stop(true);
    }
  });
});
