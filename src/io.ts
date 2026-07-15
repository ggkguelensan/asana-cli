import { CliError } from "./errors";
import { createReadStream, existsSync, statSync } from "node:fs";
import { z } from "zod";
import { zodIssueSummary } from "./schemas";

export async function readTextInput(value: string, label: string): Promise<string> {
  if (value === "-") return Bun.stdin.text();
  if (value.startsWith("@")) {
    const path = value.slice(1);
    if (!path) throw new CliError(`${label}: missing path after @`, 2);
    const file = Bun.file(path);
    if (!(await file.exists())) throw new CliError(`${label}: file not found: ${path}`, 2);
    return file.text();
  }
  return value;
}

export async function readJsonInput<S extends z.ZodType>(
  value: string,
  label: string,
  schema: S,
): Promise<z.output<S>> {
  const text = await readTextInput(value, label);
  try {
    const decoded: unknown = JSON.parse(text);
    const parsed = schema.safeParse(decoded);
    if (!parsed.success) {
      throw new CliError(`${label}: invalid value: ${zodIssueSummary(parsed.error)}`, 2);
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof CliError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`${label}: invalid JSON: ${message}`, 2);
  }
}

export async function readAgentJsonInput<S extends z.ZodType>(
  value: string | undefined,
  schema: S,
): Promise<z.output<S>> {
  if (value !== "-") {
    throw new CliError("Agent commands require JSON on stdin via --input -", 2);
  }
  const text = await Bun.stdin.text();
  if (new TextEncoder().encode(text).byteLength > 65_536) {
    throw new CliError("Agent input exceeds the 64 KiB limit", 2);
  }
  if (!text.trim()) throw new CliError("Agent input is empty", 2);
  try {
    const decoded: unknown = JSON.parse(text);
    const parsed = schema.safeParse(decoded);
    if (!parsed.success) {
      throw new CliError(`Agent input validation failed: ${zodIssueSummary(parsed.error)}`, 2);
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof CliError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Agent input is not valid JSON: ${message}`, 2);
  }
}

export function printJson(value: unknown, compact = false): void {
  process.stdout.write(`${JSON.stringify(value, null, compact ? 0 : 2)}\n`);
}

export function materializeFileReferences(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(materializeFileReferences);
  if (!value || typeof value !== "object") return value;
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  if (!parsed.success) throw new CliError("File reference container must be an object", 2);
  const record = parsed.data;
  if (Object.keys(record).length === 1 && typeof record.$file === "string") {
    const path = record.$file;
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new CliError(`File reference does not point to a regular file: ${path}`, 2);
    }
    return createReadStream(path);
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, materializeFileReferences(entry)]),
  );
}
