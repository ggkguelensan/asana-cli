import { booleanFlag, type ParsedArgs } from "./args";
import { agentActionDescriptor, agentActionDescriptors } from "./agent-contract";
import { CliError } from "./errors";
import { z } from "zod";
import { AGENT_PROTOCOL_VERSION, CLI_VERSION } from "./version";

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
  const write = command === "task" && ["update", "comment"].includes(action ?? "");
  if (write) {
    throw new CliError(
      "policy-denied",
      "Use agent prepare-* and apply-* instead of direct task writes in agent mode",
    );
  }
  const agentApply = command === "agent" &&
    action !== undefined &&
    agentActionDescriptor(action)?.effect === "write";
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
  protocol: "asana-cli-agent-v1",
  default_mode: "read-only",
  invocation: "JSON object on stdin via --input -",
  safe_commands: actionDescriptors
    .filter((descriptor) => descriptor.effect !== "write")
    .map((descriptor) => `agent ${descriptor.action}`),
  guarded_commands: Object.fromEntries(
    actionDescriptors
      .filter((descriptor) => descriptor.effect === "write")
      .map((descriptor) => [
        `agent ${descriptor.action}`,
        "ASANA_CLI_AGENT_POLICY=read-write + external host approval",
      ]),
  ),
  forbidden_commands: ["agent raw", "agent api", "auth pat set", "auth pat delete"],
  actions: actionDescriptors,
  output_security: {
    active_credential_exact_redaction: true,
    heuristic_secret_detection: false,
    prompt_injection_boundary: "All Asana text is marked as untrusted content",
    limitation: "Unknown secrets already stored in Asana content cannot be reliably detected",
    max_string_length: 8000,
  },
};
