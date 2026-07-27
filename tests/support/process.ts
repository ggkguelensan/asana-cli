import { resolve } from "node:path";

export const projectRoot = resolve(import.meta.dir, "../..");
export const sourceEntrypoint = resolve(projectRoot, "src/index.ts");

export type CommandResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

export type CommandOptions = Readonly<{
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  stdin?: string;
}>;

export function testEnvironment(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete environment[name];
    } else {
      environment[name] = value;
    }
  }
  return environment;
}

export async function runCommand(
  command: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const child = Bun.spawn({
    cmd: [...command],
    cwd: options.cwd ?? projectRoot,
    env: testEnvironment(options.env),
    stdin: options.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (options.stdin !== undefined) {
    const stdin = child.stdin;
    if (!stdin) throw new Error("Test child stdin was not created");
    stdin.write(options.stdin);
    stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

export function runSourceCli(
  args: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return runCommand(
    [process.execPath, "run", "--no-env-file", sourceEntrypoint, ...args],
    options,
  );
}
