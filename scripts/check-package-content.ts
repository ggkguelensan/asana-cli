import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CLI_VERSION } from "../src/version";

/** Exercises the shipped binary without credentials, network access, or source imports. */
export async function verifyPackageContent(binaryArgument = "dist/asana-cli"): Promise<void> {
  const binary = resolve(binaryArgument);
  const home = await mkdtemp(join(tmpdir(), "asana-cli-contract-"));
  const environment = Object.fromEntries(Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && !/^(ASANA_|HOME$|XDG_|NODE_|BUN_)/.test(entry[0]),
  ));
  try {
    async function run(args: string[]) {
      const child = Bun.spawn([binary, ...args], {
        cwd: home,
        env: { ...environment, HOME: home, XDG_CONFIG_HOME: home, XDG_STATE_HOME: home,
          ASANA_ACCESS_TOKEN: "CONTRACT_OFFLINE_CREDENTIAL" },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      return { stdout, stderr, code };
    }
    const version = await run(["--version"]);
    if (version.code !== 0 || version.stdout.trim() !== CLI_VERSION) throw new Error("Compiled version mismatch");
    const api = await run(["api", "list"]);
    if (api.code !== 0) throw new Error("SDK discovery failed");
    const data: unknown = JSON.parse(api.stdout);
    if (!data || typeof data !== "object" || !("classes" in data) || !Array.isArray(data.classes) ||
      !["TasksApi", "NotificationsApi", "TablesApi", "RecordsApi"].every((name) => (data.classes as unknown[]).includes(name))) {
      throw new Error("Compiled SDK is missing required API classes");
    }
    const doctor = await run(["doctor", "--offline"]);
    if (doctor.code !== 0 || !doctor.stdout.includes('"authentication"')) throw new Error("Offline doctor failed");
    for (const args of [["agent"], ["--agents"], ["me", "--agent"], ["agent-setup"], ["integrations"], ["context"], ["insights"], ["update"], ["task", "find-git", "example"]]) {
      const result = await run(args);
      if (result.code !== 2 || result.stdout !== "" || !result.stderr.includes('"code": "usage"')) {
        throw new Error(`Removed interface is still accepted: ${args.join(" ")}`);
      }
    }
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
