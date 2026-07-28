import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const entrypoint = resolve(import.meta.dir, "../src/index.ts");
const temporaryDirectories: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "asana-cli-insights-"));
  temporaryDirectories.push(root);
  return {
    root,
    home: join(root, "home"),
    state: join(root, "state"),
  };
}

async function run(
  args: readonly string[],
  directories: Awaited<ReturnType<typeof fixture>>,
) {
  const child = Bun.spawn([process.execPath, "run", "--no-env-file", entrypoint, ...args], {
    cwd: directories.root,
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

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("metadata-only CLI insights", () => {
  test("summarizes local history without serializing arguments or secrets", async () => {
    const directories = await fixture();
    await run(["man", "glossary"], directories);
    await run(["doctor", "--offline", "--compact"], directories);
    await run(["task", "get", "1200123456789"], directories);

    const invocation = await run(["insights", "--days", "30", "--compact"], directories);
    expect(invocation).toMatchObject({ exitCode: 0, stderr: "" });
    const report = JSON.parse(invocation.stdout) as {
      schema: string;
      summary: { invocations: number };
      commands: Array<{ name: string }>;
      privacy: { metadata_only: boolean; source_path: string };
    };
    expect(report.schema).toBe("asana-cli.insights.v1");
    expect(report.summary.invocations).toBe(3);
    expect(report.commands.map(({ name }) => name)).toContain("doctor");
    expect(report.privacy.metadata_only).toBeTrue();

    const history = await readFile(report.privacy.source_path, "utf8");
    expect(history).not.toContain("1200123456789");
  });

  test("rejects a malformed local history event", async () => {
    const directories = await fixture();
    const initial = await run(["man"], directories);
    expect(initial.exitCode).toBe(0);
    const historyPath = join(
      directories.state,
      "asana-cli",
      "audit",
      "invocations.jsonl",
    );
    await writeFile(historyPath, '{"schema":"tampered"}\n');

    const invocation = await run(["insights", "--compact"], directories);
    expect(invocation.exitCode).toBe(3);
    expect(invocation.stderr).toContain("storage-invalid");
  });

  test("omits the local history path in agent mode", async () => {
    const directories = await fixture();
    await run(["man"], directories);
    const invocation = await run(["insights", "--agent", "--compact"], directories);

    expect(invocation.exitCode).toBe(0);
    const envelope = JSON.parse(invocation.stdout) as {
      result: { privacy: { source_path: string | null } };
    };
    expect(envelope.result.privacy.source_path).toBeNull();
  });
});
