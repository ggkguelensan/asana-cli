import { booleanFlag, type ParsedArgs } from "./args";
import { CliError } from "./errors";
import { z } from "zod";

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
    throw new CliError("Agent mode cannot create, replace, or delete stored credentials", 2);
  }
  if (command === "request" || command === "api" && action === "call") {
    throw new CliError("Raw/API calls are not part of the direct agent contract", 2);
  }
  const write = command === "task" && ["update", "comment"].includes(action ?? "");
  if (write) {
    throw new CliError(
      "Use agent prepare-* and apply-* instead of direct task writes in agent mode",
      2,
    );
  }
  const agentApply = command === "agent" && ["apply-task-update", "apply-comment"].includes(action ?? "");
  if (agentApply && agentEnvironment().ASANA_CLI_AGENT_POLICY !== "read-write") {
    throw new CliError(
      "Agent writes are disabled. Start the agent host with ASANA_CLI_AGENT_POLICY=read-write; host approval is still required.",
      2,
    );
  }
}

export const AGENT_MANIFEST = {
  protocol: "asana-cli-agent-v1",
  default_mode: "read-only",
  invocation: "JSON object on stdin via --input -",
  safe_commands: [
    "agent status",
    "agent my-tasks",
    "agent get-task",
    "agent list-comments",
    "agent search-tasks",
    "agent find-git",
    "agent prepare-task-update",
    "agent prepare-comment",
  ],
  guarded_commands: {
    "agent apply-task-update": "ASANA_CLI_AGENT_POLICY=read-write + external host approval",
    "agent apply-comment": "ASANA_CLI_AGENT_POLICY=read-write + external host approval",
  },
  forbidden_commands: ["agent raw", "agent api", "auth pat set", "auth pat delete"],
  output_security: {
    active_credential_exact_redaction: true,
    heuristic_secret_detection: false,
    prompt_injection_boundary: "All Asana text is marked as untrusted content",
    limitation: "Unknown secrets already stored in Asana content cannot be reliably detected",
    max_string_length: 8000,
  },
};
