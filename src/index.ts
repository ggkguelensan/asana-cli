#!/usr/bin/env bun
import { errorPayload, normalizeError } from "./errors";
import { printJson } from "./io";
import { runCli } from "./cli";
import { protectOutput } from "./security";
import { hardenRuntime } from "./bootstrap";

try {
  hardenRuntime();
  const result = await runCli(process.argv.slice(2));
  if (result.text !== undefined) {
    process.stdout.write(`${result.text}\n`);
  } else if (result.value !== undefined) {
    printJson(protectOutput(result.value).value, result.compact);
  }
} catch (error) {
  const normalized = normalizeError(error, process.env.ASANA_ACCESS_TOKEN ?? process.env.ASANA_PAT);
  process.stderr.write(`${JSON.stringify(protectOutput(errorPayload(normalized)).value, null, 2)}\n`);
  process.exitCode = normalized.exitCode;
}
