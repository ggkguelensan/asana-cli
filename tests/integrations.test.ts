import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  EMBEDDED_INTEGRATION_BUNDLE,
  type EmbeddedIntegrationClientId,
} from "../generated/integrations/bundle";
import {
  INTEGRATION_CLIENTS,
  INTEGRATION_CLIENT_IDS,
} from "../integrations/clients";
import {
  INTEGRATION_MANIFEST_FILE,
  doctorIntegration,
  inspectIntegration,
  integrationManifestSchema,
  planUninstallIntegration,
  planUpdateIntegration,
  uninstallIntegration,
  updateIntegration,
} from "../src/integrations";
import { AGENT_PROTOCOL_COMPATIBILITY } from "../src/version";

const projectRoot = resolve(import.meta.dir, "..");
const entrypoint = resolve(projectRoot, "src/index.ts");
const temporaryDirectories: string[] = [];

type Scope = "user" | "project";
type LifecycleCase = Readonly<{ client: EmbeddedIntegrationClientId; scope: Scope }>;

type CliResult = Readonly<{ stdout: string; stderr: string; exitCode: number }>;

const lifecycleCases: readonly LifecycleCase[] = EMBEDDED_INTEGRATION_BUNDLE.clients.flatMap(
  ({ client }) => (["user", "project"] as const).map((scope) => ({ client, scope })),
);

const inspectionSchema = z.looseObject({
  state: z.enum(["absent", "managed", "modified", "unmanaged", "invalid", "unsafe"]),
});
const planSchema = z.looseObject({
  action: z.enum(["install", "update", "uninstall", "none"]),
  current_state: z.enum(["absent", "managed", "modified", "unmanaged", "invalid", "unsafe"]),
  changes: z.array(z.unknown()),
});
const executionSchema = z.looseObject({
  action: z.enum(["install", "update", "uninstall", "none"]),
  changes: z.array(z.unknown()),
});
const executionResultSchema = z.looseObject({ plan: planSchema, execution: executionSchema });
const doctorSchema = z.looseObject({
  inspection: inspectionSchema,
  inherited_credentials: z.array(z.enum(["ASANA_ACCESS_TOKEN", "ASANA_PAT"])),
  credential_sources: z.looseObject({
    effective: z.enum(["ASANA_ACCESS_TOKEN", "ASANA_PAT", "os-credential-store", "none", "unknown"]),
    environment: z.looseObject({ status: z.enum(["clear", "inherited"]) }),
    os_credential_store: z.looseObject({
      status: z.enum(["configured", "absent", "unavailable", "not-checked"]),
    }),
  }),
  warnings: z.array(z.looseObject({ code: z.string() })),
  permission_review: z.looseObject({
    status: z.enum(["not-provided", "no-known-broad-permissions", "unsafe"]),
    checked_rules: z.number(),
    findings: z.array(z.looseObject({ rule_index: z.number(), code: z.string() })),
  }),
  suggested_never_auto_allow: z.array(z.string()),
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asana-cli-integrations-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function runIntegration(
  args: readonly string[],
  options: Readonly<{ cwd: string; home: string; env?: Readonly<Record<string, string>> }>,
): Promise<CliResult> {
  const child = Bun.spawn([process.execPath, "run", "--no-env-file", entrypoint, ...args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      ASANA_ACCESS_TOKEN: "",
      ASANA_PAT: "",
      HOME: options.home,
      ...options.env,
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

function parseOutput(output: string): unknown {
  return JSON.parse(output);
}

function installationDirectory(base: string, client: EmbeddedIntegrationClientId, scope: Scope): string {
  const bundle = EMBEDDED_INTEGRATION_BUNDLE.clients.find((candidate) => candidate.client === client);
  if (!bundle) throw new Error(`Missing generated bundle for ${client}`);
  return join(base, ...bundle.install_roots[scope].split("/"));
}

async function installManagedIntegration(
  client: EmbeddedIntegrationClientId,
  scope: Scope,
): Promise<Readonly<{ home: string; project: string; base: string; installation: string }>> {
  const root = await temporaryDirectory();
  const home = join(root, "home");
  const project = join(root, "project");
  await Promise.all([mkdir(home), mkdir(project)]);
  const base = scope === "user" ? home : project;
  const applied = await runIntegration([
    "integrations",
    "install",
    "--client",
    client,
    "--scope",
    scope,
    "--apply",
  ], { cwd: project, home });
  expect(applied.exitCode).toBe(0);
  expect(executionResultSchema.parse(parseOutput(applied.stdout)).execution.action).toBe("install");
  return { home, project, base, installation: installationDirectory(base, client, scope) };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});


test("keeps every integration registry entry on the canonical protocol range", () => {
  for (const client of Object.values(INTEGRATION_CLIENTS)) {
    expect(client.protocol).toEqual(AGENT_PROTOCOL_COMPATIBILITY);
  }
});
describe("pre-PAT integration commands", () => {
  test("lists static clients and exposes policy plus credential-safe doctor guidance without auth", async () => {
    const root = await temporaryDirectory();
    const home = join(root, "home");
    const project = join(root, "project");
    await Promise.all([mkdir(home), mkdir(project)]);

    const listed = await runIntegration(["integrations", "list"], { cwd: project, home });
    expect(listed.exitCode).toBe(0);
    const list = z.looseObject({
      schema: z.string(),
      bundle_version: z.string(),
      agent_protocol_version: z.number(),
      runtime: z.looseObject({
        platform: z.enum(["darwin", "linux"]),
        architecture: z.enum(["arm64", "x64"]),
      }),
      clients: z.record(z.string(), z.unknown()),
    }).parse(parseOutput(listed.stdout));
    expect(list.schema).toBe("asana-cli.integration-bundle.v1");
    expect(list.runtime).toEqual({
      platform: z.enum(["darwin", "linux"]).parse(process.platform),
      architecture: z.enum(["arm64", "x64"]).parse(process.arch),
    });
    expect(Object.keys(list.clients).sort()).toEqual([...INTEGRATION_CLIENT_IDS].sort());
    expect(Object.fromEntries(
      Object.entries(INTEGRATION_CLIENTS).map(([id, client]) => [id, client.support]),
    )).toEqual({
      "generic-agent-skills": "generic",
      codex: "supported",
      "claude-code": "supported",
      "gemini-cli": "experimental",
      "github-copilot": "experimental",
      opencode: "experimental",
      cursor: "experimental",
      pi: "experimental",
      "kimi-code": "experimental",
    });
    expect(Object.fromEntries(
      Object.entries(INTEGRATION_CLIENTS).map(([id, client]) => [
        id,
        client.qualification.kind,
      ]),
    )).toEqual({
      "generic-agent-skills": "generic-contract",
      codex: "behavioral-eval",
      "claude-code": "behavioral-eval",
      "gemini-cli": "adapter-only",
      "github-copilot": "adapter-only",
      opencode: "adapter-only",
      cursor: "adapter-only",
      pi: "adapter-only",
      "kimi-code": "adapter-only",
    });

    const detected = await runIntegration([
      "integrations", "detect", "--client", "codex", "--scope", "project",
    ], { cwd: project, home });
    expect(detected.exitCode).toBe(0);
    expect(z.looseObject({ discovery: z.literal("absent"), inspection: inspectionSchema }).parse(parseOutput(detected.stdout)).inspection.state)
      .toBe("absent");

    const status = await runIntegration([
      "integrations", "status", "--client", "codex", "--scope", "project",
    ], { cwd: project, home });
    expect(status.exitCode).toBe(0);
    expect(inspectionSchema.parse(parseOutput(status.stdout)).state).toBe("absent");

    const accessToken = "DOCTOR_ACCESS_TOKEN_CANARY_987654";
    const pat = "DOCTOR_PAT_CANARY_987654";
    const doctor = await runIntegration([
      "integrations", "doctor", "--client", "codex", "--scope", "project",
      "--skip-credential-store",
      "--auto-allow", "asana-cli agent status",
      "--auto-allow", "asana-cli api *",
      "--auto-allow", "/usr/local/bin/asana-cli agent apply --operation-id *",
    ], { cwd: project, home, env: { ASANA_ACCESS_TOKEN: accessToken, ASANA_PAT: pat } });
    expect(doctor.exitCode).toBe(0);
    const doctorResult = doctorSchema.parse(parseOutput(doctor.stdout));
    expect(doctorResult.inspection.state).toBe("absent");
    expect(doctorResult.inherited_credentials).toEqual(["ASANA_ACCESS_TOKEN", "ASANA_PAT"]);
    expect(doctorResult.credential_sources.effective).toBe("ASANA_ACCESS_TOKEN");
    expect(doctorResult.credential_sources.environment.status).toBe("inherited");
    expect(doctorResult.credential_sources.os_credential_store.status).toBe("not-checked");
    expect(doctorResult.warnings.map((warning) => warning.code)).toEqual([
      "inherited-environment-credential",
    ]);
    expect(doctorResult.permission_review).toMatchObject({
      status: "unsafe",
      checked_rules: 3,
      findings: [
        { rule_index: 1, code: "raw-api" },
        { rule_index: 2, code: "write-apply" },
      ],
    });
    expect(doctorResult.suggested_never_auto_allow).toEqual(["api", "request", "auth", "apply"]);
    expect(`${doctor.stdout}${doctor.stderr}`).not.toContain(accessToken);
    expect(`${doctor.stdout}${doctor.stderr}`).not.toContain(pat);

    const policy = await runIntegration(["integrations", "policy", "codex"], { cwd: project, home });
    expect(policy.exitCode).toBe(0);
    expect(policy.stdout).toContain("## Never auto-allow");
    for (const prohibitedCommand of [
      "asana-cli api *",
      "asana-cli request *",
      "asana-cli auth *",
      "asana-cli integrations install --apply",
      "asana-cli integrations update --apply",
      "asana-cli integrations uninstall --apply",
    ]) {
      expect(policy.stdout).toContain(prohibitedCommand);
    }

    const clientNotes = {
      "gemini-cli": "contains only this skill and no MCP server",
      "github-copilot": "Do not add allowed-tools: shell or bash",
      opencode: "do not use --auto",
      cursor: "shell permissions are coarse",
    } as const;
    for (const [client, note] of Object.entries(clientNotes)) {
      const result = await runIntegration(
        ["integrations", "policy", client],
        { cwd: project, home },
      );
      expect(result.exitCode, client).toBe(0);
      expect(result.stdout, client).toContain(note);
    }
    const canonicalSkill = EMBEDDED_INTEGRATION_BUNDLE.clients[0]?.files.find(
      (file) => file.path === "SKILL.md",
    )?.content;
    expect(canonicalSkill).toBeDefined();
    expect(canonicalSkill).not.toContain("allowed-tools:");
  });
  test("reports Codex .agents/skills/asana discovery roots for user and project scopes", async () => {
    const root = await temporaryDirectory();
    const home = join(root, "home");
    const project = join(root, "project");
    await Promise.all([mkdir(home), mkdir(project)]);

    for (const target of [
      { scope: "user", base: home },
      { scope: "project", base: project },
    ] as const) {
      const detected = await runIntegration([
        "integrations", "detect", "--client", "codex", "--scope", target.scope,
      ], { cwd: project, home });
      expect(detected.exitCode, target.scope).toBe(0);
      const result = z.looseObject({
        discovery: z.literal("absent"),
        inspection: inspectionSchema,
        target: z.looseObject({ base_directory: z.string(), installation_directory: z.string() }),
      }).parse(parseOutput(detected.stdout));
      expect(relative(result.target.base_directory, result.target.installation_directory), target.scope).toBe(
        join(".agents", "skills", "asana"),
      );
      expect(result.inspection.state, target.scope).toBe("absent");
    }
  });

  test("resolves every native client root without touching settings, hooks, or MCP configuration", async () => {
    const root = await temporaryDirectory();
    const home = join(root, "home");
    const project = join(root, "project");
    await Promise.all([mkdir(home), mkdir(project)]);
    const expectedRoots = {
      "generic-agent-skills": {
        user: ".agents/skills/asana",
        project: ".agents/skills/asana",
      },
      codex: {
        user: ".agents/skills/asana",
        project: ".agents/skills/asana",
      },
      "claude-code": {
        user: ".claude/skills/asana",
        project: ".claude/skills/asana",
      },
      "gemini-cli": {
        user: ".gemini/skills/asana",
        project: ".gemini/skills/asana",
      },
      "github-copilot": {
        user: ".copilot/skills/asana",
        project: ".github/skills/asana",
      },
      opencode: {
        user: ".config/opencode/skills/asana",
        project: ".opencode/skills/asana",
      },
      cursor: {
        user: ".cursor/skills/asana",
        project: ".cursor/skills/asana",
      },
      pi: {
        user: ".pi/agent/skills/asana",
        project: ".pi/skills/asana",
      },
      "kimi-code": {
        user: ".kimi-code/skills/asana",
        project: ".kimi-code/skills/asana",
      },
    } as const;

    for (const client of INTEGRATION_CLIENT_IDS) {
      for (const scope of ["user", "project"] as const) {
        const detected = await runIntegration([
          "integrations", "detect", "--client", client, "--scope", scope,
        ], { cwd: project, home });
        expect(detected.exitCode, `${client}:${scope}`).toBe(0);
        const result = z.looseObject({
          discovery: z.literal("absent"),
          target: z.looseObject({
            base_directory: z.string(),
            installation_directory: z.string(),
          }),
        }).parse(parseOutput(detected.stdout));
        expect(
          relative(result.target.base_directory, result.target.installation_directory)
            .split("\\").join("/"),
          `${client}:${scope}`,
        ).toBe(expectedRoots[client][scope]);
      }
    }
  }, 15_000);

  test("reports credential-store states without returning secrets or storage errors", async () => {
    const root = await temporaryDirectory();
    const project = join(root, "project");
    await mkdir(project);
    const input = {
      target: { client: "codex", scope: "project", project_directory: project },
      environment: {},
    } as const;
    const secret = "DOCTOR_STORED_PAT_CANARY_938245";

    const configured = await doctorIntegration(input, {
      read_stored_pat: async () => secret,
    });
    expect(configured.credential_sources.effective).toBe("os-credential-store");
    expect(configured.credential_sources.os_credential_store.status).toBe("configured");
    expect(JSON.stringify(configured)).not.toContain(secret);

    const absent = await doctorIntegration(input, {
      read_stored_pat: async () => null,
    });
    expect(absent.credential_sources.effective).toBe("none");
    expect(absent.credential_sources.os_credential_store.status).toBe("absent");

    const unavailable = await doctorIntegration(input, {
      read_stored_pat: async () => {
        throw new Error(`credential backend leaked ${secret}`);
      },
    });
    expect(unavailable.credential_sources.effective).toBe("unknown");
    expect(unavailable.credential_sources.os_credential_store.status).toBe("unavailable");
    expect(unavailable.warnings.map((warning) => warning.code)).toContain("credential-store-unavailable");
    expect(JSON.stringify(unavailable)).not.toContain(secret);
  });

  test("doctor detects known broad permission examples without echoing their text", async () => {
    const root = await temporaryDirectory();
    const home = join(root, "home");
    const project = join(root, "project");
    await Promise.all([mkdir(home), mkdir(project)]);
    const canary = "PERMISSION_RULE_CANARY_735921";
    const rules = [
      "Bash(asana-cli *)",
      "allow:/opt/asana/bin/asana-cli request *",
      "Bash(asana-cli auth pat get)",
      "Bash(asana-cli agent *)",
      "asana-cli integrations update --apply",
      `unrecognized-host-syntax ${canary}`,
    ];
    const result = await runIntegration([
      "integrations", "doctor", "--client", "claude-code", "--scope", "project",
      "--skip-credential-store",
      ...rules.flatMap((rule) => ["--auto-allow", rule]),
    ], { cwd: project, home });
    expect(result.exitCode).toBe(0);
    const parsed = doctorSchema.parse(parseOutput(result.stdout));
    expect(parsed.permission_review).toMatchObject({
      status: "unsafe",
      checked_rules: rules.length,
      findings: [
        { rule_index: 0, code: "broad-cli" },
        { rule_index: 1, code: "raw-request" },
        { rule_index: 2, code: "credential-management" },
        { rule_index: 3, code: "broad-agent" },
        { rule_index: 4, code: "integration-lifecycle-apply" },
      ],
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(canary);
  });

  test("rejects malformed client, scope, duplicate options, and ambiguous write confirmation", async () => {
    const root = await temporaryDirectory();
    const home = join(root, "home");
    const project = join(root, "project");
    await Promise.all([mkdir(home), mkdir(project)]);

    const cases = [
      {
        name: "unknown client",
        args: ["integrations", "status", "--client", "unknown-client", "--scope", "project"],
        message: "--client must be one of: generic-agent-skills, codex, claude-code, gemini-cli, github-copilot, opencode, cursor, pi, kimi-code",
      },
      {
        name: "invalid scope",
        args: ["integrations", "status", "--client", "codex", "--scope", "global"],
        message: "--scope must be user or project",
      },
      {
        name: "duplicate client option",
        args: ["integrations", "status", "--client", "codex", "--client", "claude-code", "--scope", "project"],
        message: "--client may be provided only once",
      },
      {
        name: "missing mutation confirmation",
        args: ["integrations", "install", "--client", "codex", "--scope", "project"],
        message: "requires exactly one of --dry-run",
      },
      {
        name: "disabled dry run",
        args: ["integrations", "install", "--client", "codex", "--scope", "project", "--dry-run=false"],
        message: "--dry-run must be enabled when supplied",
      },
      {
        name: "both mutation confirmations",
        args: ["integrations", "install", "--client", "codex", "--scope", "project", "--dry-run", "--apply"],
        message: "requires exactly one of --dry-run",
      },
    ] as const;

    for (const invalid of cases) {
      const result = await runIntegration(invalid.args, { cwd: project, home });
      expect(result.exitCode, invalid.name).toBe(2);
      expect(result.stderr, invalid.name).toContain(invalid.message);
    }
  });
});

describe("generated client integration lifecycle", () => {
  for (const lifecycle of lifecycleCases) {
    test(`${lifecycle.client} ${lifecycle.scope} installation owns exact bundle bytes and leaves unrelated files alone`, async () => {
      const root = await temporaryDirectory();
      const home = join(root, "home");
      const project = join(root, "project");
      await Promise.all([mkdir(home), mkdir(project)]);
      const base = lifecycle.scope === "user" ? home : project;
      const unrelated = join(base, "AGENTS.md");
      await writeFile(unrelated, "do not change\n");
      const installation = installationDirectory(base, lifecycle.client, lifecycle.scope);
      const expectedBundle = EMBEDDED_INTEGRATION_BUNDLE.clients.find((candidate) => candidate.client === lifecycle.client);
      if (!expectedBundle) throw new Error(`Missing generated bundle for ${lifecycle.client}`);

      const diffBeforeInstall = await runIntegration([
        "integrations", "diff", "--client", lifecycle.client, "--scope", lifecycle.scope,
      ], { cwd: project, home });
      expect(diffBeforeInstall.exitCode).toBe(0);
      expect(planSchema.parse(parseOutput(diffBeforeInstall.stdout)).action).toBe("install");

      const preview = await runIntegration([
        "integrations", "install", "--client", lifecycle.client, "--scope", lifecycle.scope, "--dry-run",
      ], { cwd: project, home });
      expect(preview.exitCode).toBe(0);
      expect(planSchema.parse(parseOutput(preview.stdout)).current_state).toBe("absent");
      expect(existsSync(installation)).toBe(false);

      const installed = await runIntegration([
        "integrations", "install", "--client", lifecycle.client, "--scope", lifecycle.scope, "--apply",
      ], { cwd: project, home });
      expect(installed.exitCode).toBe(0);
      expect(executionResultSchema.parse(parseOutput(installed.stdout)).execution.action).toBe("install");

      const manifest = integrationManifestSchema.parse(JSON.parse(await readFile(join(installation, INTEGRATION_MANIFEST_FILE), "utf8")));
      expect(manifest.client).toBe(lifecycle.client);
      expect(manifest.scope).toBe(lifecycle.scope);
      expect(Object.keys(manifest.files).sort()).toEqual(expectedBundle.files.map((file) => file.path).sort());
      for (const file of expectedBundle.files) {
        const content = await readFile(join(installation, file.path), "utf8");
        expect(content).toBe(file.content);
        expect(`sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`).toBe(file.sha256);
        expect(manifest.files[file.path]).toBe(file.sha256);
      }

      const detected = await runIntegration([
        "integrations", "detect", "--client", lifecycle.client, "--scope", lifecycle.scope,
      ], { cwd: project, home });
      expect(detected.exitCode).toBe(0);
      expect(z.looseObject({ discovery: z.literal("found"), inspection: inspectionSchema }).parse(parseOutput(detected.stdout)).inspection.state)
        .toBe("managed");

      const status = await runIntegration([
        "integrations", "status", "--client", lifecycle.client, "--scope", lifecycle.scope,
      ], { cwd: project, home });
      expect(status.exitCode).toBe(0);
      expect(inspectionSchema.parse(parseOutput(status.stdout)).state).toBe("managed");

      const diffAfterInstall = await runIntegration([
        "integrations", "diff", "--client", lifecycle.client, "--scope", lifecycle.scope,
      ], { cwd: project, home });
      expect(diffAfterInstall.exitCode).toBe(0);
      const cleanDiff = planSchema.parse(parseOutput(diffAfterInstall.stdout));
      expect(cleanDiff.action).toBe("none");
      expect(cleanDiff.changes).toEqual([]);

      const update = await runIntegration([
        "integrations", "update", "--client", lifecycle.client, "--scope", lifecycle.scope, "--apply",
      ], { cwd: project, home });
      expect(update.exitCode).toBe(0);
      expect(executionResultSchema.parse(parseOutput(update.stdout)).execution.action).toBe("none");
      expect(await readFile(unrelated, "utf8")).toBe("do not change\n");

      const uninstallPreview = await runIntegration([
        "integrations", "uninstall", "--client", lifecycle.client, "--scope", lifecycle.scope, "--dry-run",
      ], { cwd: project, home });
      expect(uninstallPreview.exitCode).toBe(0);
      expect(planSchema.parse(parseOutput(uninstallPreview.stdout)).action).toBe("uninstall");

      const uninstalled = await runIntegration([
        "integrations", "uninstall", "--client", lifecycle.client, "--scope", lifecycle.scope, "--apply",
      ], { cwd: project, home });
      expect(uninstalled.exitCode).toBe(0);
      expect(executionResultSchema.parse(parseOutput(uninstalled.stdout)).execution.action).toBe("uninstall");
      expect(existsSync(installation)).toBe(false);
      expect(await readFile(unrelated, "utf8")).toBe("do not change\n");
    }, 15_000);
  }
});

describe("integration ownership safety", () => {
  test("refuses to update or uninstall a modified managed bundle", async () => {
    const installed = await installManagedIntegration("codex", "project");
    await writeFile(join(installed.installation, "SKILL.md"), "locally modified\n");

    const status = await runIntegration([
      "integrations", "status", "--client", "codex", "--scope", "project",
    ], { cwd: installed.project, home: installed.home });
    expect(status.exitCode).toBe(0);
    expect(inspectionSchema.parse(parseOutput(status.stdout)).state).toBe("modified");

    for (const action of ["update", "uninstall"] as const) {
      const refused = await runIntegration([
        "integrations", action, "--client", "codex", "--scope", "project", "--dry-run",
      ], { cwd: installed.project, home: installed.home });
      expect(refused.exitCode, action).toBe(4);
      expect(refused.stderr, action).toContain("integration is modified");
    }
  });

  test("refuses to claim or remove an installation with unmanaged files", async () => {
    const installed = await installManagedIntegration("generic-agent-skills", "user");
    const unmanaged = join(installed.installation, "operator-notes.txt");
    await writeFile(unmanaged, "keep this file\n");
    await chmod(unmanaged, 0o600);

    const status = await runIntegration([
      "integrations", "status", "--client", "generic-agent-skills", "--scope", "user",
    ], { cwd: installed.project, home: installed.home });
    expect(status.exitCode).toBe(0);
    expect(inspectionSchema.parse(parseOutput(status.stdout)).state).toBe("unmanaged");

    const refused = await runIntegration([
      "integrations", "uninstall", "--client", "generic-agent-skills", "--scope", "user", "--apply",
    ], { cwd: installed.project, home: installed.home });
    expect(refused.exitCode).toBe(4);
    expect(refused.stderr).toContain("integration is unmanaged");
    expect(await readFile(unmanaged, "utf8")).toBe("keep this file\n");
  });

  test("treats symlinked artifacts as unsafe and leaves their targets untouched", async () => {
    const installed = await installManagedIntegration("claude-code", "project");
    const skill = join(installed.installation, "SKILL.md");
    const external = join(installed.base, "external-skill.md");
    await writeFile(external, "outside the managed tree\n");
    await unlink(skill);
    await symlink(external, skill);

    const detected = await runIntegration([
      "integrations", "detect", "--client", "claude-code", "--scope", "project",
    ], { cwd: installed.project, home: installed.home });
    expect(detected.exitCode).toBe(0);
    expect(z.looseObject({ discovery: z.literal("unsafe"), inspection: inspectionSchema }).parse(parseOutput(detected.stdout)).inspection.state)
      .toBe("unsafe");

    for (const action of ["diff", "update", "uninstall"] as const) {
      const args = action === "diff"
        ? ["integrations", action, "--client", "claude-code", "--scope", "project"]
        : ["integrations", action, "--client", "claude-code", "--scope", "project", "--dry-run"];
      const refused = await runIntegration(args, { cwd: installed.project, home: installed.home });
      expect(refused.exitCode, action).toBe(4);
      expect(refused.stderr, action).toContain("integration is unsafe");
    }
    expect(await readFile(external, "utf8")).toBe("outside the managed tree\n");
  });
});

describe("v0.4 integration lifecycle remediation", () => {
  test("agent mode denies every lifecycle apply and renders the exact never-auto-allow guidance", async () => {
    const root = await temporaryDirectory();
    const home = join(root, "home");
    const project = join(root, "project");
    await Promise.all([mkdir(home), mkdir(project)]);

    const policy = await runIntegration(["integrations", "policy", "codex"], { cwd: project, home });
    expect(policy.exitCode).toBe(0);
    const neverAutoAllow = policy.stdout.match(/## Never auto-allow\n([\s\S]*?)\n\n## Safety notes/);
    expect(neverAutoAllow?.[1]).toBe([
      "- `asana-cli api *`",
      "- `asana-cli request *`",
      "- `asana-cli auth *`",
      "- `asana-cli integrations install --apply`",
      "- `asana-cli integrations update --apply`",
      "- `asana-cli integrations uninstall --apply`",
    ].join("\n"));

    for (const action of ["install", "update", "uninstall"] as const) {
      const denied = await runIntegration([
        "integrations", action, "--client", "codex", "--scope", "project", "--apply",
      ], { cwd: project, home, env: { ASANA_CLI_AGENT: "1" } });
      expect(denied.exitCode, action).toBe(2);
      expect(denied.stderr, action).toContain("Agent mode cannot apply integration lifecycle changes");
      expect(existsSync(installationDirectory(project, "codex", "project")), action).toBe(false);
    }
  });

  test("classifies group-readable POSIX integrations as unsafe and refuses update or uninstall", async () => {
    const installed = await installManagedIntegration("codex", "project");
    await chmod(installed.installation, 0o755);

    const status = await runIntegration([
      "integrations", "status", "--client", "codex", "--scope", "project",
    ], { cwd: installed.project, home: installed.home });
    expect(status.exitCode).toBe(0);
    const inspection = z.looseObject({ state: z.literal("unsafe"), reason: z.string() }).parse(parseOutput(status.stdout));
    expect(inspection.reason).toBe("Integration root grants permissions to group or other users");

    for (const action of ["update", "uninstall"] as const) {
      const refused = await runIntegration([
        "integrations", action, "--client", "codex", "--scope", "project", "--dry-run",
      ], { cwd: installed.project, home: installed.home });
      expect(refused.exitCode, action).toBe(4);
      expect(refused.stderr, action).toContain(`Cannot ${action}: integration is unsafe`);
    }
  });

  test("classifies an integration reported as owned by another POSIX user as unsafe", async () => {
    const installed = await installManagedIntegration("claude-code", "project");
    const target = { client: "claude-code", scope: "project", project_directory: installed.project } as const;
    const originalLstat = fsPromises.lstat;
    const effectiveUserId = process.geteuid?.();
    if (effectiveUserId === undefined) throw new Error("POSIX effective user is unavailable");
    const foreignUid = effectiveUserId + 1;
    const lstatSpy = spyOn(fsPromises, "lstat");
    lstatSpy.mockImplementation((async (path) => {
      const stats = await originalLstat(path);
      if (path !== installed.installation) return stats;
      const foreignStats = Object.create(stats) as typeof stats;
      Object.defineProperty(foreignStats, "uid", { value: foreignUid });
      return foreignStats;
    }) as typeof fsPromises.lstat);

    try {
      const inspection = await inspectIntegration(target);
      expect(inspection).toMatchObject({
        state: "unsafe",
        reason: "Integration root is not owned by the current effective user",
      });
      await expect(planUpdateIntegration({
        target,
        cli_version: "ownership-check",
        agent_protocol_version: 2,
        files: { "SKILL.md": "unreachable" },
      })).rejects.toThrow("Cannot update: integration is unsafe");
      await expect(planUninstallIntegration(target)).rejects.toThrow("Cannot uninstall: integration is unsafe");
    } finally {
      lstatSpy.mockRestore();
    }
  });

  test("classifies oversized manifests and artifacts as unsafe before reading them", async () => {
    const cases = [
      { name: "manifest", relativePath: INTEGRATION_MANIFEST_FILE, limit: 256 * 1024, label: "Integration ownership manifest" },
      { name: "artifact", relativePath: "SKILL.md", limit: 2 * 1024 * 1024, label: "Integration artifact" },
    ] as const;

    for (const oversized of cases) {
      const installed = await installManagedIntegration("generic-agent-skills", "user");
      await writeFile(join(installed.installation, oversized.relativePath), "x".repeat(oversized.limit + 1));

      const status = await runIntegration([
        "integrations", "status", "--client", "generic-agent-skills", "--scope", "user",
      ], { cwd: installed.project, home: installed.home });
      expect(status.exitCode, oversized.name).toBe(0);
      const inspection = z.looseObject({ state: z.literal("unsafe"), reason: z.string() }).parse(parseOutput(status.stdout));
      expect(inspection.reason, oversized.name).toBe(
        `${oversized.label} exceeds the ${oversized.limit}-byte read limit`,
      );
    }
  });

  for (const action of ["update", "uninstall"] as const) {
    test(`${action} restores a backup mutated after planning instead of deleting it`, async () => {
      const installed = await installManagedIntegration("codex", "project");
      const target = { client: "codex", scope: "project", project_directory: installed.project } as const;
      const manifestBeforeMutation = await readFile(join(installed.installation, INTEGRATION_MANIFEST_FILE), "utf8");
      const backupMutation = `mutated while ${action} backup was pending verification\n`;
      const originalRename = fsPromises.rename;
      const renameSpy = spyOn(fsPromises, "rename").mockImplementation(async (source, destination) => {
        await originalRename(source, destination);
        if (typeof destination === "string" && destination.includes(".asana-cli-backup-")) {
          await writeFile(join(destination, "SKILL.md"), backupMutation);
        }
      });

      try {
        if (action === "update") {
          const bundle = EMBEDDED_INTEGRATION_BUNDLE.clients.find((candidate) => candidate.client === "codex");
          if (!bundle) throw new Error("Missing generated Codex bundle");
          await expect(updateIntegration({
            target,
            cli_version: "backup-race-test",
            agent_protocol_version: bundle.agent_protocol_version,
            files: Object.fromEntries(bundle.files.map((file) => [file.path, file.content])),
          })).rejects.toThrow("Integration tree does not match its ownership manifest");
        } else {
          await expect(uninstallIntegration(target)).rejects.toThrow(
            "Integration tree does not match its ownership manifest",
          );
        }
      } finally {
        renameSpy.mockRestore();
      }

      expect(existsSync(installed.installation)).toBe(true);
      expect(await readFile(join(installed.installation, "SKILL.md"), "utf8")).toBe(backupMutation);
      expect(await readFile(join(installed.installation, INTEGRATION_MANIFEST_FILE), "utf8")).toBe(manifestBeforeMutation);
    });
  }
});
