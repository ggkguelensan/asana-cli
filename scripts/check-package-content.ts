import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { CLI_VERSION } from "../src/version";

type CommandResult = { stdout: string; stderr: string; code: number };
type Runner = (args: string[]) => Promise<CommandResult>;

const requiredClasses = ["TasksApi", "NotificationsApi", "TablesApi", "RecordsApi"];
const sdkDiscoverySchema = z.object({ classes: z.array(z.string()) }).refine(
  ({ classes }) => requiredClasses.every((name) => classes.includes(name)),
  "Compiled SDK is missing required API classes",
);
const removedInterfaceSchema = z.object({
  code: z.literal(2), stdout: z.literal(""),
  stderr: z.string().refine((value) => value.includes('"code": "usage"')),
});

function requireResult(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function isolatedEnvironment(home: string): Record<string, string> {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && !/^(ASANA_|HOME$|XDG_|NODE_|BUN_)/.test(entry[0]),
  ));
  return { ...inherited, HOME: home, XDG_CONFIG_HOME: home, XDG_STATE_HOME: home,
    ASANA_ACCESS_TOKEN: "CONTRACT_OFFLINE_CREDENTIAL" };
}

function binaryRunner(binary: string, home: string): Runner {
  const env = isolatedEnvironment(home);
  return async (args) => {
    const child = Bun.spawn([binary, ...args], {
      cwd: home, env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { stdout, stderr, code };
  };
}

async function verifyDiscovery(run: Runner): Promise<void> {
  const version = await run(["--version"]);
  requireResult(version.code === 0 && version.stdout.trim() === CLI_VERSION, "Compiled version mismatch");
  const api = await run(["api", "list"]);
  requireResult(api.code === 0, "SDK discovery failed");
  sdkDiscoverySchema.parse(JSON.parse(api.stdout) as unknown);
  const doctor = await run(["doctor", "--offline"]);
  requireResult(doctor.code === 0 && doctor.stdout.includes('"authentication"'), "Offline doctor failed");
}

async function verifyRemovedInterfaces(run: Runner): Promise<void> {
  for (const args of [["agent"], ["--agents"], ["me", "--agent"], ["agent-setup"], ["integrations"], ["context"], ["insights"], ["update"], ["task", "find-git", "example"]]) {
    removedInterfaceSchema.parse(await run(args));
  }
}

/** Exercises the shipped binary without network access or real credentials. */
export async function verifyPackageContent(binaryArgument = "dist/asana-cli"): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "asana-cli-contract-"));
  try {
    const run = binaryRunner(resolve(binaryArgument), home);
    await verifyDiscovery(run);
    await verifyRemovedInterfaces(run);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [binary, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error("Usage: check-package-content.ts [BINARY]");
  await verifyPackageContent(binary);
  console.log("Compiled Asana CLI contract verified");
}
