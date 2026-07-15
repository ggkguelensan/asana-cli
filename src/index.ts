#!/usr/bin/env bun
import { errorPayload, normalizeError } from "./errors";
import { printJson } from "./io";
import { runCli } from "./cli";
import { protectOutput, secureAgentEnvelope } from "./security";
import { hardenRuntime } from "./bootstrap";

try {
  hardenRuntime();
  const result = await runCli(process.argv.slice(2));
  if (result.text !== undefined) {
    process.stdout.write(`${result.text}\n`);
  } else if (result.value !== undefined) {
    const agentMode = result.agentMode ?? (
      process.argv.includes("--agent") || process.env.ASANA_CLI_AGENT === "1"
    );
    printJson(agentMode ? secureAgentEnvelope(result.value) : protectOutput(result.value).value, result.compact);
  }
} catch (error) {
  const normalized = normalizeError(error, process.env.ASANA_PAT ?? process.env.ASANA_ACCESS_TOKEN);
  const agentMode = process.argv.includes("--agent") ||
    process.argv.slice(2)[0] === "agent" ||
    process.env.ASANA_CLI_AGENT === "1";
  const payload = agentMode
    ? secureAgentEnvelope(errorPayload(normalized))
    : protectOutput(errorPayload(normalized)).value;
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = normalized.exitCode;
}
