import { z } from "zod";
import { CliError } from "./errors";

const MAX_GIT_OUTPUT_BYTES = 1_024;
const GIT_COMMAND_TIMEOUT_MS = 2_000;
const MAX_BRANCH_LENGTH = 128;
const MAX_GIT_TOKENS = 16;
const MAX_GIT_TOKEN_NUMBER = 2_147_483_647;

export const normalizedHostSchema = z.string().regex(
  /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/,
).refine((value) => !value.includes(".."), "Invalid remote host");
export const repositoryPartSchema = z.string().regex(
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/,
);
export const gitRepositoryIdentitySchema = z.strictObject({
  remote: z.strictObject({ host: normalizedHostSchema }),
  repository: z.strictObject({ owner: repositoryPartSchema, name: repositoryPartSchema }),
});
export type GitRepositoryIdentity = z.output<typeof gitRepositoryIdentitySchema>;
const normalizedBranchSchema = z.string()
  .min(1)
  .max(MAX_BRANCH_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]$|^[A-Za-z0-9]$/)
  .refine((value) => !value.includes("..") && !value.includes("//") && !value.includes("@{"), {
    message: "Invalid branch",
  })
  .refine((value) => !value.split("/").some((part) => part.endsWith(".lock")), {
    message: "Invalid branch",
  });

export const gitContextTokenSchema = z.strictObject({
  kind: z.enum(["pull-request", "issue"]),
  number: z.number().int().positive().max(MAX_GIT_TOKEN_NUMBER),
});

export const gitContextSchema = z.strictObject({
  remote: z.strictObject({
    host: normalizedHostSchema,
  }),
  repository: z.strictObject({
    owner: repositoryPartSchema,
    name: repositoryPartSchema,
  }),
  branch: normalizedBranchSchema.nullable(),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  tokens: z.array(gitContextTokenSchema).max(MAX_GIT_TOKENS),
});

/** Normalized, bounded, non-secret Git data for the current worktree. */
export type GitContext = z.output<typeof gitContextSchema>;

const GIT_ENV = {
  PATH: "/usr/bin:/bin",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  LC_ALL: "C",
  LANG: "C",
};

const GIT_COMMANDS = {
  remote: ["git", "config", "--local", "--no-includes", "--get", "remote.origin.url"],
  branch: ["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
  commit: ["git", "rev-parse", "--verify", "HEAD^{commit}"],
} as const;

type GitCommandName = keyof typeof GIT_COMMANDS;

async function readBoundedBytes(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new Error("Git output exceeded the limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function gitUnavailable(): CliError {
  return new CliError("not-found", "Git context is unavailable from the current worktree");
}

function invalidGitOutput(): CliError {
  return new CliError("validation", "Git context contains unsupported or invalid data");
}

async function runFixedGitCommand(name: GitCommandName): Promise<string | null> {
  let process: Bun.Subprocess;
  try {
    process = Bun.spawn({
      cmd: [...GIT_COMMANDS[name]],
      env: GIT_ENV,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    throw gitUnavailable();
  }

  const stdoutStream = process.stdout;
  const stderrStream = process.stderr;
  if (
    stdoutStream === undefined || stderrStream === undefined ||
    typeof stdoutStream === "number" || typeof stderrStream === "number"
  ) {
    process.kill();
    throw gitUnavailable();
  }

  const timeout = setTimeout(() => process.kill(), GIT_COMMAND_TIMEOUT_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBoundedBytes(stdoutStream, MAX_GIT_OUTPUT_BYTES),
      readBoundedBytes(stderrStream, MAX_GIT_OUTPUT_BYTES),
      process.exited,
    ]);
    if (name === "branch" && exitCode === 1 && stdout.byteLength === 0 && stderr.byteLength === 0) {
      return null;
    }
    if (exitCode !== 0 || stderr.byteLength !== 0) throw gitUnavailable();
    const output = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
    if (!/^[^\r\n\u0000]+\n$/.test(output)) throw invalidGitOutput();
    return output.slice(0, -1);
  } catch (error) {
    process.kill();
    if (error instanceof CliError) throw error;
    throw invalidGitOutput();
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeRemote(value: string): Pick<GitContext, "remote" | "repository"> {
  const scp = /^git@([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?):([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:\.git)?$/.exec(value);
  const url = /^https:\/\/([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:\.git)?$/.exec(value)
    ?? /^ssh:\/\/git@([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:\.git)?$/.exec(value);
  const match = scp ?? url;
  if (!match) throw invalidGitOutput();

  const parsed = z.strictObject({
    remote: z.strictObject({ host: normalizedHostSchema }),
    repository: z.strictObject({ owner: repositoryPartSchema, name: repositoryPartSchema }),
  }).safeParse({
    remote: { host: match[1].toLowerCase() },
    repository: { owner: match[2], name: match[3].replace(/\.git$/, "") },
  });
  if (!parsed.success) throw invalidGitOutput();
  return parsed.data;
}

function normalizeBranch(value: string): string {
  const parsed = normalizedBranchSchema.safeParse(value);
  if (!parsed.success) throw invalidGitOutput();
  return parsed.data;
}

function normalizeCommit(value: string): string {
  if (!/^[a-f0-9]{40}$/.test(value)) throw invalidGitOutput();
  return value;
}

function extractTokens(branch: string): GitContext["tokens"] {
  const matches = branch.matchAll(/(?:^|[^A-Za-z0-9])(?:(pr|pull)[-_/]?(\d{1,10})|(issue|issues)[-_/]?(\d{1,10})|#(\d{1,10}))(?=$|[^A-Za-z0-9])/gi);
  const tokens: GitContext["tokens"] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    const kind = match[1] ? "pull-request" : "issue";
    const numberText = match[2] ?? match[4] ?? match[5];
    const number = Number(numberText);
    if (!Number.isSafeInteger(number) || number < 1 || number > MAX_GIT_TOKEN_NUMBER) continue;
    const key = `${kind}:${number}`;
    if (!seen.has(key)) {
      seen.add(key);
      tokens.push({ kind, number });
      if (tokens.length === MAX_GIT_TOKENS) break;
    }
  }
  return tokens;
}

/** Reads normalized, non-secret Git context from the current worktree using fixed Git argv only. */
export async function readCurrentGitContext(): Promise<GitContext> {
  const [remoteOutput, branchOutput, commitOutput] = await Promise.all([
    runFixedGitCommand("remote"),
    runFixedGitCommand("branch"),
    runFixedGitCommand("commit"),
  ]);
  if (remoteOutput === null || commitOutput === null) throw gitUnavailable();
  const remote = normalizeRemote(remoteOutput);
  const branch = branchOutput === null ? null : normalizeBranch(branchOutput);
  return gitContextSchema.parse({
    ...remote,
    branch,
    commit: normalizeCommit(commitOutput),
    tokens: branch === null ? [] : extractTokens(branch),
  });
}
