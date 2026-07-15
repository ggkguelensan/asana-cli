import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  EMBEDDED_INTEGRATION_BUNDLE,
  embeddedIntegrationBundleSchema,
} from "../generated/integrations/bundle";
import { INTEGRATION_MANIFEST_FILE, integrationManifestSchema } from "../src/integrations";
import { CLI_VERSION } from "../src/version";

const cliEntrypoint = resolve(import.meta.dir, "../src/index.ts");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "asana-cli-package-content-"));
const probeBinary = join(temporaryDirectory, "asana-cli-embedded-bundle-probe");

async function runProbe(args: readonly string[], cwd: string): Promise<string> {
  const probe = Bun.spawn({
    cmd: [probeBinary, ...args],
    cwd,
    env: { ...process.env, HOME: cwd },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(probe.stdout).text(),
    new Response(probe.stderr).text(),
    probe.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Embedded bundle probe failed: ${stderr}`);
  return stdout;
}

try {
  const build = await Bun.build({
    entrypoints: [cliEntrypoint],
    compile: { outfile: probeBinary },
    minify: false,
  });
  if (!build.success) {
    throw new Error(`Embedded bundle probe did not compile: ${build.logs.join("\n")}`);
  }

  const listed = JSON.parse(await runProbe(["integrations", "list"], temporaryDirectory));
  const packaged = embeddedIntegrationBundleSchema.parse(EMBEDDED_INTEGRATION_BUNDLE);
  if (
    listed.schema !== packaged.schema ||
    listed.bundle_version !== packaged.bundle_version ||
    listed.agent_protocol_version !== packaged.agent_protocol_version
  ) {
    throw new Error("Compiled package does not expose the generated integration bundle metadata");
  }

  for (const expected of packaged.clients) {
    const clientDirectory = join(temporaryDirectory, expected.client);
    await mkdir(clientDirectory, { recursive: true });
    await runProbe([
      "integrations",
      "install",
      "--client",
      expected.client,
      "--scope",
      "project",
      "--apply",
    ], clientDirectory);

    const installationDirectory = join(clientDirectory, ...expected.install_roots.project.split("/"));
    const manifestText = await Bun.file(join(installationDirectory, INTEGRATION_MANIFEST_FILE)).text();
    const manifest = integrationManifestSchema.parse(JSON.parse(manifestText));
    if (manifest.client !== expected.client || manifest.scope !== "project" || manifest.cli_version !== CLI_VERSION) {
      throw new Error(`Compiled package wrote the wrong manifest metadata for ${expected.client}`);
    }

    for (const file of expected.files) {
      const content = await Bun.file(join(installationDirectory, file.path)).text();
      const digest = `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
      if (content !== file.content || digest !== file.sha256 || manifest.files[file.path] !== file.sha256) {
        throw new Error(`Compiled package does not contain the exact embedded bundle: ${expected.client}/${file.path}`);
      }
    }
  }

  process.stdout.write("Compiled package contains the exact embedded integration bundles\n");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
