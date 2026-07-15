import { CliError } from "./errors";
import { z } from "zod";

export type FlagValue = string | boolean | string[];

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, FlagValue>;
}

function addFlag(flags: Record<string, FlagValue>, name: string, value: string | boolean) {
  const existing = flags[name];
  if (existing === undefined) {
    flags[name] = value;
  } else if (Array.isArray(existing)) {
    existing.push(String(value));
  } else {
    flags[name] = [String(existing), String(value)];
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  const tokens = z.array(z.string()).parse(argv);
  const positionals: string[] = [];
  const flags: Record<string, FlagValue> = {};
  let positionalOnly = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (positionalOnly) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      positionalOnly = true;
      continue;
    }
    if (token === "-h") {
      addFlag(flags, "help", true);
      continue;
    }
    if (token === "-V" || token === "-v") {
      addFlag(flags, "version", true);
      continue;
    }
    if (token.startsWith("--no-") && !token.includes("=")) {
      addFlag(flags, token.slice(5), false);
      continue;
    }
    if (token.startsWith("--")) {
      const equals = token.indexOf("=");
      if (equals !== -1) {
        addFlag(flags, token.slice(2, equals), token.slice(equals + 1));
        continue;
      }
      const name = token.slice(2);
      if (!name) throw new CliError("Invalid empty option", 2);
      const next = tokens[index + 1];
      if (next !== undefined && (!next.startsWith("-") || next === "-")) {
        addFlag(flags, name, next);
        index += 1;
      } else {
        addFlag(flags, name, true);
      }
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      throw new CliError(`Unknown short option: ${token}`, 2);
    }
    positionals.push(token);
  }

  return { positionals, flags };
}

export function flag(args: ParsedArgs, name: string): string | boolean | undefined {
  const value = args.flags[name];
  return Array.isArray(value) ? value[value.length - 1] : value;
}

export function flagStrings(args: ParsedArgs, name: string): string[] {
  const value = args.flags[name];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [String(value)];
}

export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = flag(args, name);
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new CliError(`--${name} requires a value`, 2);
  }
  return value;
}

export function booleanFlag(
  args: ParsedArgs,
  name: string,
  defaultValue = false,
): boolean {
  const value = flag(args, name);
  if (value === undefined) return defaultValue;
  if (typeof value === "boolean") return value;
  if (["true", "1", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["false", "0", "no", "off"].includes(value.toLowerCase())) return false;
  throw new CliError(`--${name} must be true or false`, 2);
}

export function integerFlag(
  args: ParsedArgs,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const raw = stringFlag(args, name);
  if (raw === undefined) return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new CliError(`--${name} must be an integer between ${minimum} and ${maximum}`, 2);
  }
  return value;
}

export function requirePositional(
  args: ParsedArgs,
  index: number,
  description: string,
): string {
  const value = args.positionals[index];
  if (!value) throw new CliError(`Missing ${description}`, 2);
  return value;
}
