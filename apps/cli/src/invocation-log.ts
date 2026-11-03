import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { parseArgs, type ParsedArgs } from "./args";
import { resolveAuditLogDirectory } from "./audit/paths";
import { agentActionDescriptor } from "./agent-contract";
import type { CliErrorCode } from "./errors";
import { CLI_VERSION } from "./version";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_EVENT_BYTES = 4 * 1_024;
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9-]{0,63}$/;
const nodeErrorSchema = z.object({ code: z.string() });

export const INVOCATION_LOG_SCHEMA = "asana-cli.invocation-log.v1" as const;
export const INVOCATION_LOG_FILE = "invocations.jsonl" as const;

export const invocationEffectSchema = z.enum([
  "read",
  "remote-write",
  "local-write",
  "maintenance",
  "diagnostic",
  "unknown",
]);

export const invocationLogEventSchema = z.strictObject({
  schema: z.literal(INVOCATION_LOG_SCHEMA),
  invocation_id: z.uuid(),
  started_at: z.iso.datetime({ offset: true }),
  completed_at: z.iso.datetime({ offset: true }),
  duration_ms: z.number().int().nonnegative(),
  cli_version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  command: z.string().regex(SAFE_SEGMENT),
  action: z.string().regex(SAFE_SEGMENT).nullable(),
  effect: invocationEffectSchema,
  agent_mode: z.boolean(),
  outcome: z.enum(["success", "error"]),
  exit_code: z.number().int().min(0).max(255),
  error_code: z.string().regex(SAFE_SEGMENT).nullable(),
});

export type InvocationLogEvent = z.output<typeof invocationLogEventSchema>;
export type InvocationEffect = z.output<typeof invocationEffectSchema>;

export type InvocationLogInput = Readonly<{
  argv: readonly string[];
  startedAt: Date;
  completedAt?: Date;
  durationMs: number;
  exitCode: number;
  errorCode?: CliErrorCode;
  invocationId?: string;
}>;

export type InvocationLogProbe = Readonly<{
  path: string;
  ready: true;
}>;

function nodeErrorCode(error: unknown): string | undefined {
  const parsed = nodeErrorSchema.safeParse(error);
  return parsed.success ? parsed.data.code : undefined;
}

function safeSegment(value: string | undefined, fallback: string): string {
  return value && SAFE_SEGMENT.test(value) ? value : fallback;
}

function parsedInvocation(argv: readonly string[]): ParsedArgs | undefined {
  try {
    return parseArgs([...argv]);
  } catch {
    return undefined;
  }
}

function invocationEffect(args: ParsedArgs | undefined): InvocationEffect {
  if (!args) return "unknown";
  const [command, action] = args.positionals;
  if (!command && Object.hasOwn(args.flags, "agents")) return "read";
  if (command === "doctor") return "diagnostic";
  if (command === "update") return "maintenance";
  if (command === "insights") return "diagnostic";
  if (command === "agent-setup") {
    return Object.hasOwn(args.flags, "apply") ? "local-write" : "read";
  }
  if (command === "task" && ["update", "comment"].includes(action ?? "")) {
    return "remote-write";
  }
  if (command === "agent" && action) {
    const descriptor = agentActionDescriptor(action);
    return descriptor?.effect === "write"
      ? "remote-write"
      : descriptor
        ? "read"
        : "unknown";
  }
  if (command === "context") {
    return ["alias", "bind", "activate", "deactivate", "clear"].includes(action ?? "")
      ? "local-write"
      : "read";
  }
  if (command === "integrations") {
    return ["install", "update", "uninstall"].includes(action ?? "") &&
        Object.hasOwn(args.flags, "apply")
      ? "local-write"
      : "read";
  }
  if (
    command === "auth" &&
    action === "pat" &&
    ["set", "delete", "remove"].includes(args.positionals[2] ?? "")
  ) {
    return "local-write";
  }
  if (command === "request") {
    const method = args.positionals[1]?.toUpperCase();
    return method && !["GET", "HEAD", "OPTIONS"].includes(method)
      ? "remote-write"
      : "read";
  }
  if (command === "api" && action === "call") return "unknown";
  return command ? "read" : "unknown";
}

function invocationDescriptor(argv: readonly string[]): Readonly<{
  command: string;
  action: string | null;
  effect: InvocationEffect;
  agentMode: boolean;
}> {
  const args = parsedInvocation(argv);
  const command = safeSegment(
    args?.positionals[0] ?? (Object.hasOwn(args?.flags ?? {}, "agents") ? "agents" : undefined),
    "unknown",
  );
  let rawAction = args?.positionals[1];
  if (command === "auth" && rawAction === "pat") rawAction = args?.positionals[2] ?? "pat";
  return {
    command,
    action: rawAction === undefined ? null : safeSegment(rawAction, "unknown"),
    effect: invocationEffect(args),
    agentMode: command === "agent" ||
      command === "agents" ||
      Object.hasOwn(args?.flags ?? {}, "agent") ||
      process.env.ASANA_CLI_AGENT === "1",
  };
}

export function createInvocationLogEvent(input: InvocationLogInput): InvocationLogEvent {
  const completedAt = input.completedAt ?? new Date();
  const descriptor = invocationDescriptor(input.argv);
  return invocationLogEventSchema.parse({
    schema: INVOCATION_LOG_SCHEMA,
    invocation_id: input.invocationId ?? randomUUID(),
    started_at: input.startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    duration_ms: Math.max(0, Math.round(input.durationMs)),
    cli_version: CLI_VERSION,
    command: descriptor.command,
    action: descriptor.action,
    effect: descriptor.effect,
    agent_mode: descriptor.agentMode,
    outcome: input.exitCode === 0 ? "success" : "error",
    exit_code: input.exitCode,
    error_code: input.errorCode ?? null,
  });
}

function assertOwned(owner: number, label: string): void {
  if (typeof process.getuid !== "function" || owner !== process.getuid()) {
    throw new Error(`${label} is not owned by the current user`);
  }
}

async function prepareInvocationLogPath(
  environment: Record<string, string | undefined> = process.env,
): Promise<string> {
  const directory = resolveAuditLogDirectory(environment);
  await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
  const directoryStats = await lstat(directory);
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new Error("Invocation log directory is unsafe");
  }
  assertOwned(directoryStats.uid, "Invocation log directory");
  await chmod(directory, DIRECTORY_MODE);

  const path = join(directory, INVOCATION_LOG_FILE);
  try {
    const fileStats = await lstat(path);
    if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
      throw new Error("Invocation log file is unsafe");
    }
    assertOwned(fileStats.uid, "Invocation log file");
    await chmod(path, FILE_MODE);
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") throw error;
  }
  return path;
}

export async function probeInvocationLog(
  environment: Record<string, string | undefined> = process.env,
): Promise<InvocationLogProbe> {
  const path = await prepareInvocationLogPath(environment);
  const handle = await open(
    path,
    constants.O_CREAT |
      constants.O_APPEND |
      constants.O_WRONLY |
      (constants.O_NOFOLLOW ?? 0),
    FILE_MODE,
  );
  await handle.close();
  await chmod(path, FILE_MODE);
  return { path, ready: true };
}

export async function appendInvocationLog(
  input: InvocationLogInput,
  environment: Record<string, string | undefined> = process.env,
): Promise<InvocationLogEvent> {
  const event = createInvocationLogEvent(input);
  const serialized = `${JSON.stringify(event)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_EVENT_BYTES) {
    throw new Error("Invocation log event exceeds the size limit");
  }
  const { path } = await probeInvocationLog(environment);
  const handle = await open(
    path,
    constants.O_APPEND | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    FILE_MODE,
  );
  try {
    await handle.write(serialized, null, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return event;
}
