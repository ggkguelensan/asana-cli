import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { INTEGRATION_SKILL_IDS } from "../src/integration-skills";

const entrypoint = resolve(import.meta.dir, "../src/index.ts");
const temporaryDirectories: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "asana-cli-agent-setup-"));
  temporaryDirectories.push(root);
  const directories = {
    root,
    home: join(root, "home"),
    project: join(root, "project"),
    state: join(root, "state"),
  };
  await Promise.all([
    mkdir(directories.home, { recursive: true }),
    mkdir(directories.project, { recursive: true }),
  ]);
  return directories;
}

async function run(
  args: readonly string[],
  directories: Awaited<ReturnType<typeof fixture>>,
) {
  const child = Bun.spawn([process.execPath, "run", "--no-env-file", entrypoint, ...args], {
    cwd: directories.project,
    env: {
      ...process.env,
      HOME: directories.home,
      XDG_STATE_HOME: directories.state,
      ASANA_ACCESS_TOKEN: "",
      ASANA_PAT: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function result(output: string): Record<string, unknown> {
  const envelope = JSON.parse(output) as { result: Record<string, unknown> };
  return envelope.result;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("agent onboarding and skill suite", () => {
  test("--agents is the machine-readable first entrypoint", async () => {
    const directories = await fixture();
    const invocation = await run(["--agents", "--compact"], directories);

    expect(invocation).toMatchObject({ exitCode: 0, stderr: "" });
    const manifest = result(invocation.stdout);
    expect(manifest).toMatchObject({
      schema: "asana-cli.agents.v1",
      first_entrypoint: "asana-cli --agents",
    });
    expect((manifest.skills as Array<{ id: string }>).map(({ id }) => id)).toEqual(
      [...INTEGRATION_SKILL_IDS],
    );
  });

  test("previews then installs all skills into the selected project scope", async () => {
    const directories = await fixture();
    const common = ["agent-setup", "--client", "codex", "--scope", "project"] as const;
    const preview = await run([...common, "--dry-run", "--compact"], directories);

    expect(preview).toMatchObject({ exitCode: 0, stderr: "" });
    expect((result(preview.stdout).skills as Array<{ skill: string }>).map(
      ({ skill }) => skill,
    )).toEqual([...INTEGRATION_SKILL_IDS]);
    for (const skill of INTEGRATION_SKILL_IDS) {
      expect(existsSync(join(directories.project, ".agents", "skills", skill))).toBeFalse();
    }

    const applied = await run([...common, "--apply", "--compact"], directories);
    expect(applied).toMatchObject({ exitCode: 0, stderr: "" });
    for (const skill of INTEGRATION_SKILL_IDS) {
      const root = join(directories.project, ".agents", "skills", skill);
      expect(existsSync(join(root, "SKILL.md"))).toBeTrue();
      const manifest = JSON.parse(
        await readFile(join(root, ".asana-cli-integration.json"), "utf8"),
      ) as { skill: string };
      expect(manifest.skill).toBe(skill);
    }
  });

  test("requires an explicit scope, client, and execution mode", async () => {
    const directories = await fixture();
    const invocation = await run(
      ["agent-setup", "--client", "codex", "--scope", "project"],
      directories,
    );

    expect(invocation.exitCode).toBe(2);
    expect(invocation.stderr).toContain("exactly one of --dry-run or --apply");
  });
});
