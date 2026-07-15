import { createHash } from "node:crypto";
import { CliError } from "../errors";
import {
  INTEGRATION_INSTALLER,
  INTEGRATION_MANIFEST_SCHEMA,
  integrationManifestSchema,
  type IntegrationArtifactContents,
  type IntegrationManifest,
} from "./schemas";
import type { IntegrationPaths } from "./paths";

export function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/** Builds the only manifest format accepted as proof of installation ownership. */
export function createIntegrationManifest(
  target: IntegrationPaths,
  cliVersion: string,
  agentProtocolVersion: number,
  files: IntegrationArtifactContents,
): IntegrationManifest {
  const hashes = Object.fromEntries(
    Object.entries(files).sort(([left], [right]) => left.localeCompare(right)).map(([path, content]) => [path, sha256(content)]),
  );

  return integrationManifestSchema.parse({
    schema: INTEGRATION_MANIFEST_SCHEMA,
    installer: INTEGRATION_INSTALLER,
    cli_version: cliVersion,
    agent_protocol_version: agentProtocolVersion,
    client: target.client,
    scope: target.scope,
    files: hashes,
  });
}

export function serializeIntegrationManifest(manifest: IntegrationManifest): string {
  const parsed = integrationManifestSchema.parse(manifest);
  const files = Object.fromEntries(Object.entries(parsed.files).sort(([left], [right]) => left.localeCompare(right)));
  return `${JSON.stringify({ ...parsed, files })}\n`;
}

export function parseIntegrationManifest(value: string): IntegrationManifest {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new CliError("storage-invalid", "Integration ownership manifest is not valid JSON");
  }

  const parsed = integrationManifestSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new CliError("storage-invalid", "Integration ownership manifest has an invalid schema");
  }
  return parsed.data;
}

export function assertManifestTarget(manifest: IntegrationManifest, target: IntegrationPaths): void {
  if (manifest.client !== target.client || manifest.scope !== target.scope) {
    throw new CliError("conflict", "Integration ownership manifest belongs to a different target");
  }
}
