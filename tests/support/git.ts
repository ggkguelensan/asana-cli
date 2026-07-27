import { runCommand, testEnvironment } from "./process";

export function isolatedGitEnvironment(home: string): Record<string, string> {
  return testEnvironment({
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    LC_ALL: "C",
    LANG: "C",
  });
}

export async function runGit(
  cwd: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>> = isolatedGitEnvironment(cwd),
): Promise<string> {
  const result = await runCommand(["git", ...args], { cwd, env: environment });
  if (result.exitCode !== 0) {
    throw new Error(`Git test fixture failed: ${args.join(" ")} (${result.stderr})`);
  }
  return result.stdout.trim();
}

export function runGitSync(
  cwd: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>> = isolatedGitEnvironment(cwd),
): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Git test fixture failed: ${args.join(" ")} (${new TextDecoder().decode(result.stderr)})`,
    );
  }
  return new TextDecoder().decode(result.stdout).trim();
}
