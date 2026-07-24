export const CLI_VERSION = "1.0.0" as const;
export const AGENT_PROTOCOL_VERSION = 2 as const;
export const AGENT_PROTOCOL_COMPATIBILITY = {
  minimum: AGENT_PROTOCOL_VERSION,
  maximum: AGENT_PROTOCOL_VERSION,
} as const;
export const AGENT_PROTOCOL_UPGRADE_GUIDANCE = {
  reason: "unsupported-agent-protocol",
  supported_protocol: AGENT_PROTOCOL_COMPATIBILITY,
  required_action: "upgrade-client",
} as const;
