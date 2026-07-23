import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { reviewAutoAllowCommands, type PermissionReview } from "../client-adapter-specs";
import { CliError } from "../errors";
import { storedPat } from "../pat-store";
import {
  assertManifestTarget,
  createIntegrationManifest,
  parseIntegrationManifest,
  serializeIntegrationManifest,
  sha256,
} from "./manifest";
import { resolveIntegrationPaths, type IntegrationPaths } from "./paths";
import {
  INTEGRATION_MANIFEST_FILE,
  MAX_INTEGRATION_ARTIFACT_BYTES,
  MAX_INTEGRATION_MANIFEST_BYTES,
  integrationBundleInputSchema,
  integrationDoctorInputSchema,
  integrationTargetInputSchema,
  type IntegrationBundleInput,
  type IntegrationDoctorInput,
  type IntegrationManifest,
} from "./schemas";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

type IntegrationTreeEntry = Readonly<{
  kind: "directory" | "file";
  mode: number;
  sha256?: string;
}>;

type IntegrationSnapshot = Readonly<{
  manifest: IntegrationManifest;
  manifest_sha256: string;
  file_hashes: Readonly<Record<string, string>>;
  tree: Readonly<Record<string, IntegrationTreeEntry>>;
}>;

export type IntegrationState = "absent" | "managed" | "modified" | "unmanaged" | "invalid" | "unsafe";
export type IntegrationChangeKind = "create" | "replace" | "remove";
export type IntegrationAction = "install" | "update" | "uninstall" | "none";

export type IntegrationInspection = Readonly<{
  state: IntegrationState;
  target: IntegrationPaths;
  manifest?: IntegrationManifest;
  manifest_sha256?: string;
  file_hashes?: Readonly<Record<string, string>>;
  reason?: string;
}>;

export type IntegrationChange = Readonly<{
  kind: IntegrationChangeKind;
  path: string;
  expected_sha256?: string;
  actual_sha256?: string;
}>;

export type IntegrationPlan = Readonly<{
  action: IntegrationAction;
  dry_run: true;
  target: IntegrationPaths;
  current_state: IntegrationState;
  observed_manifest_sha256?: string;
  changes: readonly IntegrationChange[];
}>;

const plannedSnapshots = new WeakMap<IntegrationPlan, IntegrationSnapshot>();

export type IntegrationExecution = Readonly<{
  action: Exclude<IntegrationAction, "none">;
  target: IntegrationPaths;
  changes: readonly IntegrationChange[];
}>;

function nodeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return null;
    throw error;
  }
}
function assertPrivatePosixEntry(stats: { uid: number; mode: number }, label: string): void {
  const effectiveUserId = process.geteuid?.();
  if (effectiveUserId === undefined) {
    throw new CliError("internal", "Current effective user cannot be determined for integration lifecycle safety");
  }
  if (stats.uid !== effectiveUserId) {
    throw new CliError("conflict", `${label} is not owned by the current effective user`);
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new CliError("conflict", `${label} grants permissions to group or other users`);
  }
}

async function readRegularFile(path: string, maximumBytes: number, label: string): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new CliError("conflict", `${label} is not a regular file`);
    }
    assertPrivatePosixEntry(stats, label);
    if (stats.size > maximumBytes) {
      throw new CliError("conflict", `${label} exceeds the ${maximumBytes}-byte read limit`);
    }
    const content = new Uint8Array(stats.size);
    let offset = 0;
    while (offset < content.byteLength) {
      const { bytesRead } = await handle.read(content, offset, content.byteLength - offset, offset);
      if (bytesRead === 0) throw new CliError("conflict", `${label} changed during read`);
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== stats.size || after.uid !== stats.uid || after.mode !== stats.mode) {
      throw new CliError("conflict", `${label} changed during read`);
    }
    return content;
  } finally {
    await handle.close();
  }
}

async function assertRealDirectory(path: string, label: string): Promise<void> {
  const stats = await lstatOrNull(path);
  if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new CliError("conflict", `${label} must be an existing non-symlink directory`);
  }
}

async function ensureTargetParent(target: IntegrationPaths): Promise<void> {
  await assertRealDirectory(target.base_directory, "Integration base directory");
  const parent = dirname(target.installation_directory);
  const suffix = relative(target.base_directory, parent);
  if (suffix === "" || suffix === "." || suffix === ".." || suffix.startsWith(`..${sep}`)) {
    throw new CliError("internal", "integration parent escaped its fixed root");
  }

  let current = target.base_directory;
  for (const segment of suffix.split(sep)) {
    current = join(current, segment);
    const stats = await lstatOrNull(current);
    if (!stats) {
      await mkdir(current, { mode: DIRECTORY_MODE });
      const created = await lstat(current);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new CliError("conflict", "Integration parent changed while it was created");
      }
      assertPrivatePosixEntry(created, "Integration parent directory");
      continue;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new CliError("conflict", "Integration parent contains a non-directory or symlink");
    }
    assertPrivatePosixEntry(stats, "Integration parent directory");
  }
}
async function assertExistingTargetParentsAreReal(target: IntegrationPaths): Promise<void> {
  await assertRealDirectory(target.base_directory, "Integration base directory");
  const parent = dirname(target.installation_directory);
  const suffix = relative(target.base_directory, parent);
  if (suffix === "" || suffix === "." || suffix === ".." || suffix.startsWith(`..${sep}`)) {
    throw new CliError("internal", "integration parent escaped its fixed root");
  }

  let current = target.base_directory;
  for (const segment of suffix.split(sep)) {
    current = join(current, segment);
    const stats = await lstatOrNull(current);
    if (!stats) return;
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new CliError("conflict", "Integration parent contains a non-directory or symlink");
    }
    assertPrivatePosixEntry(stats, "Integration parent directory");
  }
}

async function scanArtifactTree(
  directory: string,
  manifestSha256: string,
): Promise<Readonly<{ file_hashes: Readonly<Record<string, string>>; tree: Readonly<Record<string, IntegrationTreeEntry>> }>> {
  const found: Record<string, string> = {};
  const tree: Record<string, IntegrationTreeEntry> = {};
  const root = await lstat(directory);
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new CliError("conflict", "Integration root is not a real directory");
  }
  assertPrivatePosixEntry(root, "Integration root");
  tree["."] = { kind: "directory", mode: root.mode & 0o7777 };
  const visit = async (current: string, prefix: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) {
        throw new CliError("conflict", "Integration contains a symbolic link");
      }
      if (stats.isDirectory()) {
        assertPrivatePosixEntry(stats, "Integration directory");
        tree[relativePath] = { kind: "directory", mode: stats.mode & 0o7777 };
        await visit(path, relativePath);
        continue;
      }
      if (!stats.isFile()) {
        throw new CliError("conflict", "Integration contains a non-regular file");
      }
      const label = relativePath === INTEGRATION_MANIFEST_FILE
        ? "Integration ownership manifest"
        : "Integration artifact";
      assertPrivatePosixEntry(stats, label);
      if (relativePath === INTEGRATION_MANIFEST_FILE) {
        tree[relativePath] = { kind: "file", mode: stats.mode & 0o7777, sha256: manifestSha256 };
        continue;
      }
      const hash = sha256(await readRegularFile(path, MAX_INTEGRATION_ARTIFACT_BYTES, label));
      found[relativePath] = hash;
      tree[relativePath] = { kind: "file", mode: stats.mode & 0o7777, sha256: hash };
    }
  };
  await visit(directory, "");
  return { file_hashes: found, tree };
}

function invalidInspection(target: IntegrationPaths, state: Exclude<IntegrationState, "absent" | "managed">, reason: string): IntegrationInspection {
  return { state, target, reason };
}

function inspectionReason(error: unknown, fallback: string): string {
  return error instanceof CliError ? error.message : fallback;
}

function manifestsMatch(manifest: IntegrationManifest, fileHashes: Readonly<Record<string, string>>): boolean {
  const expectedPaths = Object.keys(manifest.files).sort();
  const actualPaths = Object.keys(fileHashes).sort();
  return expectedPaths.length === actualPaths.length &&
    expectedPaths.every((path, index) => path === actualPaths[index] && fileHashes[path] === manifest.files[path]);
}

async function captureIntegrationSnapshot(target: IntegrationPaths, directory: string): Promise<IntegrationSnapshot> {
  const root = await lstat(directory);
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new CliError("conflict", "Integration root is not a real directory");
  }
  assertPrivatePosixEntry(root, "Integration root");
  const manifestPath = join(directory, INTEGRATION_MANIFEST_FILE);
  const manifestText = new TextDecoder().decode(
    await readRegularFile(manifestPath, MAX_INTEGRATION_MANIFEST_BYTES, "Integration ownership manifest"),
  );
  const manifest = parseIntegrationManifest(manifestText);
  assertManifestTarget(manifest, target);
  const manifest_sha256 = sha256(manifestText);
  const scanned = await scanArtifactTree(directory, manifest_sha256);
  return { manifest, manifest_sha256, ...scanned };
}

function snapshotsMatch(left: IntegrationSnapshot, right: IntegrationSnapshot): boolean {
  const leftTreeEntries = Object.entries(left.tree).sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath));
  const rightTreeEntries = Object.entries(right.tree).sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath));
  return left.manifest_sha256 === right.manifest_sha256 &&
    leftTreeEntries.length === rightTreeEntries.length &&
    leftTreeEntries.every(([path, entry], index) => {
      const other = rightTreeEntries[index];
      return other !== undefined &&
        path === other[0] &&
        entry.kind === other[1].kind &&
        entry.mode === other[1].mode &&
        entry.sha256 === other[1].sha256;
    });
}

async function captureManagedSnapshot(target: IntegrationPaths, directory: string): Promise<IntegrationSnapshot> {
  const snapshot = await captureIntegrationSnapshot(target, directory);
  if (!manifestsMatch(snapshot.manifest, snapshot.file_hashes)) {
    throw new CliError("conflict", "Integration tree does not match its ownership manifest");
  }
  return snapshot;
}

async function assertSnapshotUnchanged(
  target: IntegrationPaths,
  directory: string,
  expected: IntegrationSnapshot,
  message: string,
): Promise<void> {
  const actual = await captureManagedSnapshot(target, directory);
  if (!snapshotsMatch(expected, actual)) throw new CliError("conflict", message);
}

/** Reads only metadata and hashes; it never follows symlinks or writes a target. */
export async function inspectIntegration(value: unknown): Promise<IntegrationInspection> {
  const target = resolveIntegrationPaths(integrationTargetInputSchema.parse(value));
  try {
    await assertExistingTargetParentsAreReal(target);
    const installation = await lstatOrNull(target.installation_directory);
    if (!installation) return { state: "absent", target };
    if (installation.isSymbolicLink() || !installation.isDirectory()) {
      return invalidInspection(target, "unsafe", "installation path is not a real directory");
    }
    try {
      assertPrivatePosixEntry(installation, "Integration root");
    } catch (error) {
      return invalidInspection(target, "unsafe", inspectionReason(error, "Integration root is unsafe"));
    }

    const manifestStats = await lstatOrNull(target.manifest_path);
    if (!manifestStats) return invalidInspection(target, "unmanaged", "ownership manifest is missing");
    if (manifestStats.isSymbolicLink() || !manifestStats.isFile()) {
      return invalidInspection(target, "unsafe", "ownership manifest is not a regular file");
    }
    try {
      assertPrivatePosixEntry(manifestStats, "Integration ownership manifest");
    } catch (error) {
      return invalidInspection(target, "unsafe", inspectionReason(error, "ownership manifest is unsafe"));
    }

    let snapshot: IntegrationSnapshot;
    try {
      snapshot = await captureIntegrationSnapshot(target, target.installation_directory);
    } catch (error) {
      if (error instanceof CliError && error.code === "storage-invalid") {
        return invalidInspection(target, "invalid", error.message);
      }
      if (error instanceof CliError && error.message === "Integration ownership manifest belongs to a different target") {
        return invalidInspection(target, "unmanaged", "ownership manifest belongs to another target");
      }
      return invalidInspection(target, "unsafe", inspectionReason(error, "installation contains an unsafe filesystem entry"));
    }

    if (!manifestsMatch(snapshot.manifest, snapshot.file_hashes)) {
      const expectedPaths = Object.keys(snapshot.manifest.files).sort();
      const actualPaths = Object.keys(snapshot.file_hashes).sort();
      return {
        state: expectedPaths.length !== actualPaths.length || expectedPaths.some((path, index) => path !== actualPaths[index]) ? "unmanaged" : "modified",
        target,
        manifest: snapshot.manifest,
        manifest_sha256: snapshot.manifest_sha256,
        file_hashes: snapshot.file_hashes,
        reason: expectedPaths.length !== actualPaths.length || expectedPaths.some((path, index) => path !== actualPaths[index])
          ? "installation contains unmanaged or missing files"
          : "managed file content does not match its manifest hash",
      };
    }
    return {
      state: "managed",
      target,
      manifest: snapshot.manifest,
      manifest_sha256: snapshot.manifest_sha256,
      file_hashes: snapshot.file_hashes,
    };
  } catch (error) {
    return invalidInspection(target, "unsafe", inspectionReason(error, "integration path cannot be inspected safely"));
  }
}

function changesForBundle(
  inspection: IntegrationInspection,
  bundle: IntegrationBundleInput,
): readonly IntegrationChange[] {
  const desired = createIntegrationManifest(
    inspection.target,
    bundle.cli_version,
    bundle.agent_protocol_version,
    bundle.files,
  );
  const current = inspection.manifest?.files ?? {};
  const changes: IntegrationChange[] = [];
  for (const [path, expectedHash] of Object.entries(desired.files).sort(([left], [right]) => left.localeCompare(right))) {
    const actualHash = current[path];
    if (!actualHash) {
      changes.push({ kind: "create", path: join(inspection.target.installation_directory, path), expected_sha256: expectedHash });
    } else if (actualHash !== expectedHash) {
      changes.push({
        kind: "replace",
        path: join(inspection.target.installation_directory, path),
        expected_sha256: expectedHash,
        actual_sha256: actualHash,
      });
    }
  }
  for (const [path, actualHash] of Object.entries(current).sort(([left], [right]) => left.localeCompare(right))) {
    if (!(path in desired.files)) {
      changes.push({ kind: "remove", path: join(inspection.target.installation_directory, path), actual_sha256: actualHash });
    }
  }

  const currentManifest = inspection.manifest;
  if (
    !currentManifest ||
    currentManifest.cli_version !== desired.cli_version ||
    currentManifest.agent_protocol_version !== desired.agent_protocol_version ||
    Object.keys(current).length !== Object.keys(desired.files).length ||
    Object.entries(desired.files).some(([path, hash]) => current[path] !== hash)
  ) {
    changes.push({ kind: currentManifest ? "replace" : "create", path: inspection.target.manifest_path });
  }
  return changes;
}

function requireState(inspection: IntegrationInspection, expected: IntegrationState, action: string): void {
  if (inspection.state !== expected) {
    throw new CliError("conflict", `Cannot ${action}: integration is ${inspection.state}`, undefined, {
      state: inspection.state,
      reason: inspection.reason,
    });
  }
}

export async function planInstallIntegration(value: unknown): Promise<IntegrationPlan> {
  const bundle = integrationBundleInputSchema.parse(value);
  const inspection = await inspectIntegration(bundle.target);
  requireState(inspection, "absent", "install");
  return {
    action: "install",
    dry_run: true,
    observed_manifest_sha256: inspection.manifest_sha256,
    target: inspection.target,
    current_state: inspection.state,
    changes: changesForBundle(inspection, bundle),
  };
}

export async function planUpdateIntegration(value: unknown): Promise<IntegrationPlan> {
  const bundle = integrationBundleInputSchema.parse(value);
  const inspection = await inspectIntegration(bundle.target);
  requireState(inspection, "managed", "update");
  const changes = changesForBundle(inspection, bundle);
  const plan: IntegrationPlan = {
    action: changes.length === 0 ? "none" : "update",
    dry_run: true,
    observed_manifest_sha256: inspection.manifest_sha256,
    target: inspection.target,
    current_state: inspection.state,
    changes,
  };
  plannedSnapshots.set(plan, await captureManagedSnapshot(inspection.target, inspection.target.installation_directory));
  return plan;
}

export async function planInstallOrUpdateIntegration(value: unknown): Promise<IntegrationPlan> {
  const bundle = integrationBundleInputSchema.parse(value);
  const inspection = await inspectIntegration(bundle.target);
  if (inspection.state === "absent") {
    return {
      action: "install",
      dry_run: true,
      observed_manifest_sha256: inspection.manifest_sha256,
      target: inspection.target,
      current_state: inspection.state,
      changes: changesForBundle(inspection, bundle),
    };
  }
  requireState(inspection, "managed", "install or update");
  const changes = changesForBundle(inspection, bundle);
  const plan: IntegrationPlan = {
    action: changes.length === 0 ? "none" : "update",
    dry_run: true,
    observed_manifest_sha256: inspection.manifest_sha256,
    target: inspection.target,
    current_state: inspection.state,
    changes,
  };
  plannedSnapshots.set(plan, await captureManagedSnapshot(inspection.target, inspection.target.installation_directory));
  return plan;
}

export async function planUninstallIntegration(value: unknown): Promise<IntegrationPlan> {
  const inspection = await inspectIntegration(value);
  requireState(inspection, "managed", "uninstall");
  if (!inspection.manifest) {
    throw new CliError("internal", "Managed integration did not include an ownership manifest");
  }
  const plan: IntegrationPlan = {
    action: "uninstall",
    dry_run: true,
    observed_manifest_sha256: inspection.manifest_sha256,
    target: inspection.target,
    current_state: inspection.state,
    changes: [
      ...Object.entries(inspection.manifest.files).sort(([left], [right]) => left.localeCompare(right)).map(([path, hash]) => ({
        kind: "remove" as const,
        path: join(inspection.target.installation_directory, path),
        actual_sha256: hash,
      })),
      { kind: "remove", path: inspection.target.manifest_path },
    ],
  };
  plannedSnapshots.set(plan, await captureManagedSnapshot(inspection.target, inspection.target.installation_directory));
  return plan;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeStageFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: DIRECTORY_MODE });
  let handle;
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, FILE_MODE);
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function stageBundle(target: IntegrationPaths, bundle: IntegrationBundleInput): Promise<string> {
  await ensureTargetParent(target);
  const parent = dirname(target.installation_directory);
  const stage = await mkdtemp(join(parent, ".asana-cli-stage-"));
  try {
    await chmod(stage, DIRECTORY_MODE);
    for (const [path, content] of Object.entries(bundle.files).sort(([left], [right]) => left.localeCompare(right))) {
      await writeStageFile(join(stage, path), content);
    }
    const manifest = createIntegrationManifest(target, bundle.cli_version, bundle.agent_protocol_version, bundle.files);
    await writeStageFile(join(stage, INTEGRATION_MANIFEST_FILE), serializeIntegrationManifest(manifest));
    await syncDirectory(stage);
    return stage;
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

async function restoreBackup(
  target: IntegrationPaths,
  backup: string,
  published: IntegrationSnapshot | undefined,
): Promise<void> {
  const parent = dirname(target.installation_directory);
  const current = await lstatOrNull(target.installation_directory);
  if (!current) {
    await rename(backup, target.installation_directory);
    await syncDirectory(parent);
    return;
  }
  if (!published) {
    throw new CliError("conflict", "Integration target reappeared before rollback");
  }
  await assertSnapshotUnchanged(
    target,
    target.installation_directory,
    published,
    "Published integration changed before rollback",
  );
  const displaced = join(parent, `.asana-cli-rollback-${randomUUID()}`);
  await rename(target.installation_directory, displaced);
  try {
    await rename(backup, target.installation_directory);
    await syncDirectory(parent);
  } catch (error) {
    await rename(displaced, target.installation_directory).catch(() => undefined);
    throw error;
  }
}

async function replaceInstallation(
  target: IntegrationPaths,
  stage: string,
  expected: IntegrationSnapshot | undefined,
  published: IntegrationSnapshot,
): Promise<void> {
  const parent = dirname(target.installation_directory);
  if (!expected) {
    if (await lstatOrNull(target.installation_directory)) {
      throw new CliError("conflict", "Integration target appeared during installation");
    }
    await rename(stage, target.installation_directory);
    await syncDirectory(parent);
    return;
  }

  const current = await lstatOrNull(target.installation_directory);
  if (!current || current.isSymbolicLink() || !current.isDirectory()) {
    throw new CliError("conflict", "Integration target changed before atomic update");
  }
  const backup = join(parent, `.asana-cli-backup-${randomUUID()}`);
  await rename(target.installation_directory, backup);
  let backupDeletionStarted = false;
  try {
    await assertSnapshotUnchanged(
      target,
      backup,
      expected,
      "Integration changed after it was moved to the private backup",
    );
    await rename(stage, target.installation_directory);
    await syncDirectory(parent);
    backupDeletionStarted = true;
    await rm(backup, { recursive: true, force: true });
    await syncDirectory(parent);
  } catch (error) {
    if (backupDeletionStarted) {
      try {
        await assertSnapshotUnchanged(target, backup, expected, "Integration backup changed during deletion");
      } catch {
        throw new CliError("conflict", "Integration update failed; the private backup was retained without deletion");
      }
    }
    try {
      await restoreBackup(target, backup, published);
    } catch {
      throw new CliError("conflict", "Integration update failed; the private backup was retained without deletion");
    }
    throw error;
  }
}

async function executeBundle(value: unknown, mode: "install" | "update" | "install-or-update"): Promise<IntegrationExecution | IntegrationPlan> {
  const bundle = integrationBundleInputSchema.parse(value);
  const plan = mode === "install"
    ? await planInstallIntegration(bundle)
    : mode === "update"
      ? await planUpdateIntegration(bundle)
      : await planInstallOrUpdateIntegration(bundle);
  if (plan.action === "none") return plan;

  const rechecked = await inspectIntegration(bundle.target);
  requireState(rechecked, plan.current_state, plan.action);
  if (plan.observed_manifest_sha256 && rechecked.manifest_sha256 !== plan.observed_manifest_sha256) {
    throw new CliError("conflict", "Integration ownership manifest changed before apply");
  }
  const expected = plan.action === "update" ? plannedSnapshots.get(plan) : undefined;
  if (plan.action === "update" && !expected) {
    throw new CliError("internal", "Update plan did not retain an integration snapshot");
  }
  const stage = await stageBundle(plan.target, bundle);
  try {
    const published = await captureManagedSnapshot(plan.target, stage);
    await replaceInstallation(plan.target, stage, expected, published);
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
  return { action: plan.action, target: plan.target, changes: plan.changes };
}

export function installIntegration(value: unknown): Promise<IntegrationExecution | IntegrationPlan> {
  return executeBundle(value, "install");
}
export function updateIntegration(value: unknown): Promise<IntegrationExecution | IntegrationPlan> {
  return executeBundle(value, "update");
}


export function installOrUpdateIntegration(value: unknown): Promise<IntegrationExecution | IntegrationPlan> {
  return executeBundle(value, "install-or-update");
}

export async function uninstallIntegration(value: unknown): Promise<IntegrationExecution> {
  const targetInput = integrationTargetInputSchema.parse(value);
  const target = resolveIntegrationPaths(targetInput);
  const plan = await planUninstallIntegration(targetInput);
  const rechecked = await inspectIntegration(targetInput);
  requireState(rechecked, "managed", "uninstall");
  if (rechecked.manifest_sha256 !== plan.observed_manifest_sha256) {
    throw new CliError("conflict", "Integration ownership manifest changed before uninstall");
  }
  const expected = plannedSnapshots.get(plan);
  if (!expected) throw new CliError("internal", "Uninstall plan did not retain an integration snapshot");
  const parent = dirname(target.installation_directory);
  const backup = join(parent, `.asana-cli-backup-${randomUUID()}`);
  await rename(target.installation_directory, backup);
  let backupDeletionStarted = false;
  try {
    await assertSnapshotUnchanged(
      target,
      backup,
      expected,
      "Integration changed after it was moved to the private backup",
    );
    await syncDirectory(parent);
    backupDeletionStarted = true;
    await rm(backup, { recursive: true, force: true });
    await syncDirectory(parent);
  } catch (error) {
    if (backupDeletionStarted) {
      try {
        await assertSnapshotUnchanged(target, backup, expected, "Integration backup changed during deletion");
      } catch {
        throw new CliError("conflict", "Integration uninstall failed; the private backup was retained without deletion");
      }
    }
    try {
      await restoreBackup(target, backup, undefined);
    } catch {
      throw new CliError("conflict", "Integration uninstall failed; the private backup was retained without deletion");
    }
    throw error;
  }
  return { action: "uninstall", target, changes: plan.changes };
}

export async function diffIntegration(value: unknown): Promise<IntegrationPlan> {
  return planInstallOrUpdateIntegration(value);
}

export type IntegrationCredentialStoreStatus = "configured" | "absent" | "unavailable" | "not-checked";
export type IntegrationCredentialSource =
  | "ASANA_ACCESS_TOKEN"
  | "ASANA_PAT"
  | "os-credential-store"
  | "none"
  | "unknown";

export type IntegrationDoctorResult = Readonly<{
  inspection: IntegrationInspection;
  inherited_credentials: readonly ("ASANA_ACCESS_TOKEN" | "ASANA_PAT")[];
  credential_sources: Readonly<{
    effective: IntegrationCredentialSource;
    precedence: readonly ["ASANA_ACCESS_TOKEN", "ASANA_PAT", "os-credential-store"];
    environment: Readonly<{
      status: "clear" | "inherited";
      names: readonly ("ASANA_ACCESS_TOKEN" | "ASANA_PAT")[];
    }>;
    os_credential_store: Readonly<{ status: IntegrationCredentialStoreStatus }>;
  }>;
  warnings: readonly Readonly<{
    code: "inherited-environment-credential" | "credential-store-unavailable";
    message: string;
  }>[];
  permission_review: PermissionReview;
  suggested_never_auto_allow: readonly ["api", "request", "auth", "apply"];
}>;

/**
 * Reports credential presence and fixed policy guidance, but never returns,
 * logs, or validates a credential value.
 */
export async function doctorIntegration(
  value: unknown,
  options: Readonly<{ read_stored_pat?: () => Promise<string | null> }> = {},
): Promise<IntegrationDoctorResult> {
  const input: IntegrationDoctorInput = integrationDoctorInputSchema.parse(value);
  const environment = input.environment ?? process.env;
  const inheritedCredentials: ("ASANA_ACCESS_TOKEN" | "ASANA_PAT")[] = [];
  if (environment.ASANA_ACCESS_TOKEN?.trim()) inheritedCredentials.push("ASANA_ACCESS_TOKEN");
  if (environment.ASANA_PAT?.trim()) inheritedCredentials.push("ASANA_PAT");
  let credentialStoreStatus: IntegrationCredentialStoreStatus = "not-checked";
  if (input.probe_credential_store) {
    try {
      credentialStoreStatus = await (options.read_stored_pat ?? storedPat)() ? "configured" : "absent";
    } catch {
      credentialStoreStatus = "unavailable";
    }
  }
  const warnings: IntegrationDoctorResult["warnings"][number][] = [];
  if (inheritedCredentials.length > 0) {
    warnings.push({
      code: "inherited-environment-credential",
      message: "The agent process inherits an Asana credential from its environment.",
    });
  }
  if (credentialStoreStatus === "unavailable") {
    warnings.push({
      code: "credential-store-unavailable",
      message: "The OS credential store could not be inspected.",
    });
  }
  const effective: IntegrationCredentialSource = inheritedCredentials[0]
    ?? (credentialStoreStatus === "configured"
      ? "os-credential-store"
      : credentialStoreStatus === "unavailable"
        ? "unknown"
        : "none");
  return {
    inspection: await inspectIntegration(input.target),
    inherited_credentials: inheritedCredentials,
    credential_sources: {
      effective,
      precedence: ["ASANA_ACCESS_TOKEN", "ASANA_PAT", "os-credential-store"],
      environment: {
        status: inheritedCredentials.length > 0 ? "inherited" : "clear",
        names: inheritedCredentials,
      },
      os_credential_store: { status: credentialStoreStatus },
    },
    warnings,
    permission_review: reviewAutoAllowCommands(input.auto_allow_commands),
    suggested_never_auto_allow: ["api", "request", "auth", "apply"],
  };
}
