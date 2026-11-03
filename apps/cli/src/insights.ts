import { lstat, readFile } from "node:fs/promises";
import { booleanFlag, integerFlag, type ParsedArgs } from "./args";
import { CliError } from "./errors";
import {
  invocationLogEventSchema,
  probeInvocationLog,
  type InvocationLogEvent,
} from "./invocation-log";

const MAX_LOG_BYTES = 32 * 1024 * 1024;
const INSIGHTS_SCHEMA = "asana-cli.insights.v1" as const;

function requireAllowedFlags(args: ParsedArgs): void {
  for (const [name, value] of Object.entries(args.flags)) {
    if (!["days", "limit", "compact", "agent"].includes(name)) {
      throw new CliError("usage", `Unsupported insights option: --${name}`);
    }
    if (Array.isArray(value)) {
      throw new CliError("usage", `--${name} may be provided only once`);
    }
  }
}

function countBy(
  events: readonly InvocationLogEvent[],
  key: (event: InvocationLogEvent) => string | null,
): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const event of events) {
    const value = key(event);
    if (value !== null) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

function percentile95(events: readonly InvocationLogEvent[]): number {
  if (events.length === 0) return 0;
  const durations = events.map((event) => event.duration_ms).sort((left, right) => left - right);
  return durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)] ?? 0;
}

async function readEvents(limit: number): Promise<Readonly<{
  path: string;
  events: InvocationLogEvent[];
}>> {
  const { path } = await probeInvocationLog();
  const stats = await lstat(path);
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    stats.size > MAX_LOG_BYTES ||
    (typeof process.getuid === "function" && stats.uid !== process.getuid())
  ) {
    throw new CliError("storage-invalid", "Invocation history is unsafe or exceeds 32 MiB");
  }
  const text = await readFile(path, "utf8");
  const lines = text.split("\n").filter((line) => line.length > 0);
  const selected = lines.slice(-limit);
  const events = selected.map((line) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new CliError("storage-invalid", "Invocation history contains invalid JSON");
    }
    const parsed = invocationLogEventSchema.safeParse(value);
    if (!parsed.success) {
      throw new CliError("storage-invalid", "Invocation history contains an invalid event");
    }
    return parsed.data;
  });
  return { path, events };
}

function recommendations(
  events: readonly InvocationLogEvent[],
  commandCounts: ReadonlyMap<string, number>,
) {
  const results: Array<{ code: string; message: string; action: string }> = [];
  const failures = events.filter((event) => event.outcome === "error");
  const authFailures = failures.filter((event) =>
    event.error_code === "auth-required" || event.error_code === "auth-failed"
  ).length;
  const networkFailures = failures.filter((event) => event.error_code === "network").length;
  const writes = events.filter((event) =>
    event.effect === "remote-write" || event.effect === "local-write"
  );
  const failedWrites = writes.filter((event) => event.outcome === "error").length;

  if (events.length === 0) {
    results.push({
      code: "collect-history",
      message: "There is no invocation history in the selected window yet.",
      action: "Use asana-cli normally, then rerun `asana-cli insights --days 30`.",
    });
    return results;
  }
  if (failures.length / events.length >= 0.2) {
    results.push({
      code: "high-error-rate",
      message: `${Math.round(failures.length / events.length * 100)}% of recorded invocations failed.`,
      action: "Run `asana-cli doctor` and address the most frequent normalized error below.",
    });
  }
  if (authFailures >= 2) {
    results.push({
      code: "repeated-auth-errors",
      message: `${authFailures} invocations failed because authentication was missing or rejected.`,
      action: "Run `asana-cli auth pat status`; replace or rotate the PAT only if validation fails.",
    });
  }
  if (networkFailures >= 2) {
    results.push({
      code: "repeated-network-errors",
      message: `${networkFailures} invocations failed with a normalized network error.`,
      action: "Check connectivity and retry a read before repeating writes.",
    });
  }
  if (failedWrites >= 2) {
    results.push({
      code: "repeated-write-errors",
      message: `${failedWrites} local or remote write invocations failed.`,
      action: "Use dry-run or agent prepare/apply flows and inspect the exact target before retrying.",
    });
  }
  if (!commandCounts.has("doctor")) {
    results.push({
      code: "run-doctor",
      message: "No doctor run appears in the selected history.",
      action: "Run `asana-cli doctor` after installation changes or recurring failures.",
    });
  }
  if (!commandCounts.has("update")) {
    results.push({
      code: "check-updates",
      message: "No update check appears in the selected history.",
      action: "Run `asana-cli update --check` periodically.",
    });
  }
  return results.slice(0, 6);
}

export async function runInsightsCommand(args: ParsedArgs): Promise<unknown> {
  if (args.positionals.length !== 1) {
    throw new CliError("usage", "Usage: asana-cli insights [--days 30] [--limit 50000]");
  }
  requireAllowedFlags(args);
  booleanFlag(args, "compact", false);
  const days = integerFlag(args, "days", 30, 1, 365);
  const limit = integerFlag(args, "limit", 50_000, 1, 100_000);
  const history = await readEvents(limit);
  const since = Date.now() - days * 24 * 60 * 60 * 1_000;
  const events = history.events.filter((event) =>
    new Date(event.completed_at).getTime() >= since
  );
  const successes = events.filter((event) => event.outcome === "success").length;
  const errors = events.length - successes;
  const commandTable = countBy(events, (event) => event.command);
  const actionTable = countBy(
    events,
    (event) => `${event.command}${event.action ? ` ${event.action}` : ""}`,
  );
  const effectTable = countBy(events, (event) => event.effect);
  const errorTable = countBy(events, (event) => event.error_code);
  const commandCounts = new Map(commandTable.map((entry) => [entry.name, entry.count]));
  const averageDuration = events.length === 0
    ? 0
    : Math.round(events.reduce((sum, event) => sum + event.duration_ms, 0) / events.length);
  const first = events.at(0)?.completed_at ?? null;
  const last = events.at(-1)?.completed_at ?? null;
  const observations = events.length === 0
    ? ["No metadata-only invocations were recorded in this window."]
    : [
      `Most used command: ${commandTable[0]?.name ?? "unknown"} (${commandTable[0]?.count ?? 0}).`,
      `Success rate: ${Math.round(successes / events.length * 100)}%.`,
      `${events.filter((event) => event.agent_mode).length} invocations used agent mode.`,
      `${events.filter((event) => event.effect === "remote-write").length} remote-write invocations were recorded.`,
    ];

  return {
    schema: INSIGHTS_SCHEMA,
    window: { days, first_event_at: first, last_event_at: last },
    privacy: {
      metadata_only: true,
      excludes: ["free-form argument values", "GIDs", "paths", "task/comment content", "credentials"],
      source_path: booleanFlag(args, "agent", false) || process.env.ASANA_CLI_AGENT === "1"
        ? null
        : history.path,
    },
    summary: {
      invocations: events.length,
      successes,
      errors,
      success_rate: events.length === 0 ? null : Number((successes / events.length).toFixed(4)),
      average_duration_ms: averageDuration,
      p95_duration_ms: percentile95(events),
    },
    commands: commandTable,
    actions: actionTable.slice(0, 20),
    effects: effectTable,
    errors: errorTable,
    observations,
    recommendations: recommendations(events, commandCounts),
  };
}
