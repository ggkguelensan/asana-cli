import { CliError } from "./errors";
import { createReadStream, existsSync, statSync } from "node:fs";
import { z } from "zod";
import { zodIssueSummary } from "./schemas";

export async function readTextInput(value: string, label: string): Promise<string> {
  if (value === "-") return Bun.stdin.text();
  if (value.startsWith("@")) {
    const path = value.slice(1);
    if (!path) throw new CliError("usage", `${label}: missing path after @`);
    const file = Bun.file(path);
    if (!(await file.exists())) throw new CliError("not-found", `${label}: file not found: ${path}`, 2);
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
      throw new CliError("validation", `${label}: invalid value: ${zodIssueSummary(parsed.error)}`);
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof CliError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError("validation", `${label}: invalid JSON: ${message}`);
  }
}

export function printJson(value: unknown, compact = false): void {
  process.stdout.write(`${JSON.stringify(value, null, compact ? 0 : 2)}\n`);
}

export function materializeFileReferences(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(materializeFileReferences);
  if (!value || typeof value !== "object") return value;
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  if (!parsed.success) throw new CliError("validation", "File reference container must be an object");
  const record = parsed.data;
  if (Object.keys(record).length === 1 && typeof record.$file === "string") {
    const path = record.$file;
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new CliError("validation", `File reference does not point to a regular file: ${path}`);
    }
    return createReadStream(path);
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, materializeFileReferences(entry)]),
  );
}
