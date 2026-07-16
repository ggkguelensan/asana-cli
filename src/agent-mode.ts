import { booleanFlag, type ParsedArgs } from "./args";
import { agentActionDescriptor, agentActionDescriptors, agentActionInvocation } from "./agent-contract";
import { legacyAgentApplyDeprecationManifest } from "./agent-deprecations";
import { CliError } from "./errors";
import { z } from "zod";
import {
  AGENT_PROTOCOL_COMPATIBILITY,
  AGENT_PROTOCOL_UPGRADE_GUIDANCE,
  AGENT_PROTOCOL_VERSION,
  CLI_VERSION,
} from "./version";
const agentModeEnvironmentSchema = z.object({
  ASANA_CLI_AGENT: z.enum(["0", "1"]).optional().catch(undefined),
  ASANA_CLI_AGENT_POLICY: z.enum(["read", "read-write"]).optional().catch(undefined),
});

function agentEnvironment(): z.infer<typeof agentModeEnvironmentSchema> {
  return agentModeEnvironmentSchema.parse(process.env);
}

export function isAgentMode(args: ParsedArgs): boolean {
  return args.positionals[0] === "agent" ||
    booleanFlag(args, "agent", agentEnvironment().ASANA_CLI_AGENT === "1");
}

export function enforceAgentPolicy(args: ParsedArgs): void {
  if (!isAgentMode(args)) return;
  const [command, action, subaction] = args.positionals;

  if (command === "auth" && action === "pat" && ["set", "delete", "remove"].includes(subaction ?? "")) {
    throw new CliError("policy-denied", "Agent mode cannot create, replace, or delete stored credentials");
  }
  if (command === "request" || command === "api" && action === "call") {
    throw new CliError("policy-denied", "Raw/API calls are not part of the direct agent contract");
  }
  if (
    command === "integrations" &&
    ["install", "update", "uninstall"].includes(action ?? "") &&
    Object.hasOwn(args.flags, "apply")
  ) {
    throw new CliError("policy-denied", "Agent mode cannot apply integration lifecycle changes");
  }
  const write = command === "task" && ["update", "comment"].includes(action ?? "");
  if (write) {
    throw new CliError(
      "policy-denied",
      "Use agent prepare-* and agent apply --operation-id instead of direct task writes in agent mode",
    );
  }
  const legacyApply = action === "apply-task-update" || action === "apply-comment";
  const agentApply = command === "agent" && action !== undefined && (
    legacyApply || agentActionDescriptor(action)?.effect === "write"
  );
  if (agentApply && agentEnvironment().ASANA_CLI_AGENT_POLICY !== "read-write") {
    throw new CliError(
      "policy-denied",
      "Agent writes are disabled. Start the agent host with ASANA_CLI_AGENT_POLICY=read-write; host approval is still required.",
    );
  }
}

const actionDescriptors = agentActionDescriptors();

export const AGENT_MANIFEST = {
  agent_protocol_version: AGENT_PROTOCOL_VERSION,
  cli_version: CLI_VERSION,
  protocol_compatibility: AGENT_PROTOCOL_COMPATIBILITY,
  unsupported_protocol: AGENT_PROTOCOL_UPGRADE_GUIDANCE,
  protocol: "asana-cli-agent-v2",
  default_mode: "read-only",
  invocation:
    "Direct flags for reads/comment prepare/apply; one strict JSON object on stdin via --input - remains supported",
  safe_commands: actionDescriptors
    .filter((descriptor) => descriptor.effect !== "write")
    .map(agentActionInvocation),
  guarded_commands: Object.fromEntries(
    actionDescriptors
      .filter((descriptor) => descriptor.effect === "write")
      .map((descriptor) => [
        agentActionInvocation(descriptor),
        "ASANA_CLI_AGENT_POLICY=read-write + external host approval",
      ]),
  ),
  forbidden_commands: [
    "asana-cli agent raw",
    "asana-cli agent api",
    "asana-cli auth pat set",
    "asana-cli auth pat delete",
    "asana-cli integrations install --apply",
    "asana-cli integrations update --apply",
    "asana-cli integrations uninstall --apply",
  ],
  deprecated_commands: legacyAgentApplyDeprecationManifest(),
  actions: actionDescriptors,
  output_security: {
    active_credential_exact_redaction: true,
    heuristic_secret_detection: false,
    prompt_injection_boundary: "All Asana text is marked as untrusted content",
    limitation: "Unknown secrets already stored in Asana content cannot be reliably detected",
    curated_read_content_budget: true,
    emergency_max_string_length: 100_000,
  },
};
