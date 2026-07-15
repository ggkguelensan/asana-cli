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

function isOperationStatusInvocation(argv: readonly string[]): boolean {
  return argv.length === 4 &&
    argv[0] === "agent" &&
    argv[1] === "operation" &&
    argv[2] === "status" &&
    z.uuid().safeParse(argv[3]).success;
}

const argv = process.argv.slice(2);
const operationStatusInvocation = isOperationStatusInvocation(argv);

try {
  hardenRuntime({ registerSecrets: !operationStatusInvocation });
  const result = await runCli(argv);
  if (result.text !== undefined) {
    process.stdout.write(`${result.text}\n`);
  } else if (result.value !== undefined) {
    const agentMode = result.agentMode ?? (
      operationStatusInvocation ||
      argv.includes("--agent") ||
      entryEnvironmentSchema.parse(process.env).ASANA_CLI_AGENT === "1"
    );
    printJson(agentMode ? secureAgentEnvelope(result.value) : protectOutput(result.value).value, result.compact);
  }
} catch (error) {
  const environment = operationStatusInvocation ? undefined : entryEnvironmentSchema.parse(process.env);
  const normalized = normalizeError(error, environment?.ASANA_PAT ?? environment?.ASANA_ACCESS_TOKEN);
  const agentMode = operationStatusInvocation ||
    argv.includes("--agent") ||
    argv[0] === "agent" ||
    environment?.ASANA_CLI_AGENT === "1";
  const payload = agentMode
    ? secureAgentEnvelope(errorPayload(normalized))
    : protectOutput(errorPayload(normalized)).value;
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = normalized.exitCode;
}
