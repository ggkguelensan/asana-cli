import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const projectRoot = resolve(import.meta.dir, "../..");
export const binary = join(projectRoot, "dist", "asana-cli");

export type BlackBoxFixture = Readonly<{
  root: string;
  home: string;
  state: string;
  config: string;
  project: string;
  environment: Record<string, string>;
}>;

export type CommandResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}>;

const inheritedEnvironmentBlocklist =
  /^(?:ASANA_.*|BUN_.*|NODE_.*|HOME|XDG_.*|GIT_.*|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i;

function cleanInheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !inheritedEnvironmentBlocklist.test(entry[0]),
    ),
  );
}

export async function createFixture(prefix: string): Promise<BlackBoxFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const home = join(root, "home");
  const state = join(root, "state");
  const config = join(root, "config");
  const project = join(root, "project");
  await Promise.all([
    mkdir(home, { mode: 0o700 }),
    mkdir(state, { mode: 0o700 }),
    mkdir(config, { mode: 0o700 }),
    mkdir(project, { mode: 0o700 }),
  ]);
  return {
    root,
    home,
    state,
    config,
    project,
    environment: {
      ...cleanInheritedEnvironment(),
      HOME: home,
      XDG_STATE_HOME: state,
      XDG_CONFIG_HOME: config,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      LC_ALL: "C",
      LANG: "C",
    },
  };
}

export async function removeFixture(fixture: BlackBoxFixture): Promise<void> {
  await rm(fixture.root, { recursive: true, force: true });
}

export async function runBinary(
  fixture: BlackBoxFixture,
  args: readonly string[],
  options: Readonly<{
    cwd?: string;
    env?: Readonly<Record<string, string>>;
    stdin?: string;
    timeoutMs?: number;
  }> = {},
): Promise<CommandResult> {
  const child = Bun.spawn({
    cmd: [binary, ...args],
    cwd: options.cwd ?? fixture.project,
    env: { ...fixture.environment, ...options.env },
    stdin: options.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (options.stdin !== undefined) {
    const stdin = child.stdin;
    if (!stdin) throw new Error("Black-box child stdin was not created");
    stdin.write(options.stdin);
    stdin.end();
  }
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, options.timeoutMs ?? 10_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode, timedOut };
  } finally {
    clearTimeout(timeout);
  }
}

export function decodeJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${label} did not return JSON`, { cause: error });
  }
}

export async function successfulJson(
  fixture: BlackBoxFixture,
  args: readonly string[],
  options: Parameters<typeof runBinary>[2] = {},
): Promise<unknown> {
  const result = await runBinary(fixture, args, options);
  if (result.timedOut) throw new Error(`${args.join(" ")} timed out`);
  if (result.exitCode !== 0) {
    throw new Error(
      `${args.join(" ")} exited ${result.exitCode}: ${result.stderr || result.stdout}`,
    );
  }
  if (result.stderr !== "") {
    throw new Error(`${args.join(" ")} unexpectedly wrote to stderr: ${result.stderr}`);
  }
  return decodeJson(result.stdout, args.join(" "));
}

export function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

export function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

export function number(value: unknown, label: string): number {
  if (typeof value !== "number") throw new Error(`${label} must be a number`);
  return value;
}

export function wireError(payload: unknown): Record<string, unknown> {
  const root = record(payload, "error payload");
  const direct = root.error;
  if (direct !== undefined) return record(direct, "error");
  return record(record(root.result, "agent error result").error, "agent error");
}

export function git(
  fixture: BlackBoxFixture,
  cwd: string,
  args: readonly string[],
): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: fixture.environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} exited ${result.exitCode}: ${new TextDecoder().decode(result.stderr)}`,
    );
  }
  return new TextDecoder().decode(result.stdout).trim();
}

export async function allFilesystemEntries(root: string): Promise<string[]> {
  const entries: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      entries.push(path);
      if (entry.isDirectory()) await visit(path);
    }
  };
  await visit(root);
  return entries;
}
