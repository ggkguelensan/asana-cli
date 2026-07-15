#!/usr/bin/env bun
import { errorPayload, normalizeError } from "./errors";
import { printJson } from "./io";
import { runCli } from "./cli";
import { protectOutput, secureAgentEnvelope } from "./security";
import { hardenRuntime } from "./bootstrap";
import { z } from "zod";

const entryEnvironmentSchema = z.object({
  ASANA_CLI_AGENT: z.enum(["0", "1"]).optional().catch(undefined),
  ASANA_PAT: z.string().optional(),
  ASANA_ACCESS_TOKEN: z.string().optional(),
});

try {
  hardenRuntime();
  const result = await runCli(process.argv.slice(2));
  if (result.text !== undefined) {
    process.stdout.write(`${result.text}\n`);
  } else if (result.value !== undefined) {
    const environment = entryEnvironmentSchema.parse(process.env);
    const agentMode = result.agentMode ?? (
      process.argv.includes("--agent") || environment.ASANA_CLI_AGENT === "1"
    );
    printJson(agentMode ? secureAgentEnvelope(result.value) : protectOutput(result.value).value, result.compact);
  }
} catch (error) {
  const environment = entryEnvironmentSchema.parse(process.env);
  const normalized = normalizeError(error, environment.ASANA_PAT ?? environment.ASANA_ACCESS_TOKEN);
  const agentMode = process.argv.includes("--agent") ||
    process.argv.slice(2)[0] === "agent" ||
    environment.ASANA_CLI_AGENT === "1";
  const payload = agentMode
    ? secureAgentEnvelope(errorPayload(normalized))
    : protectOutput(errorPayload(normalized)).value;
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = normalized.exitCode;
}
