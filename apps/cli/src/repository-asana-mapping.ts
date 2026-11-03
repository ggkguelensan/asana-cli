import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  gitRepositoryIdentitySchema,
  type GitRepositoryIdentity,
  normalizedHostSchema,
  repositoryPartSchema,
} from "./git-context";
import { CliError } from "./errors";
import { gidSchema } from "./schemas";
import {
  assertSupportedRuntimePlatform,
  type SupportedRuntimePlatform,
} from "./platform-support";

export type RepositoryAsanaMappingPlatform = SupportedRuntimePlatform;

const LINUX_MAPPING_ROOT = "/etc";
const DARWIN_MAPPING_ROOT = "/private/etc";
const MAX_MAPPING_BYTES = 49_152;
const GROUP_OR_OTHER_WRITABLE = 0o022;

const mappingEntrySchema = z.strictObject({
  remote: z.strictObject({ host: normalizedHostSchema }),
  repository: z.strictObject({
    owner: repositoryPartSchema,
    name: repositoryPartSchema,
  }),
  workspace_gid: gidSchema,
  project_gid: gidSchema.optional(),
  git_reference_custom_field_gid: gidSchema.optional(),
});

export const repositoryAsanaMappingFileSchema = z.strictObject({
  schema: z.literal("asana-cli.repository-asana-mapping.v1"),
  mappings: z.array(mappingEntrySchema).min(1).max(100).superRefine((mappings, context) => {
    const identities = new Set<string>();
    for (const [index, mapping] of mappings.entries()) {
      const identity = `${mapping.remote.host}\u0000${mapping.repository.owner}\u0000${mapping.repository.name}`;
      if (identities.has(identity)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "Repository mappings must be unique",
        });
      }
      identities.add(identity);
    }
  }),
});

export type RepositoryAsanaMappingFile = z.output<typeof repositoryAsanaMappingFileSchema>;
export type RepositoryAsanaMapping = z.output<typeof mappingEntrySchema>;

const publicMappingSchema = mappingEntrySchema.pick({
  workspace_gid: true,
  project_gid: true,
  git_reference_custom_field_gid: true,
});

export const repositoryAsanaContextDataSchema = z.strictObject({
  git: gitRepositoryIdentitySchema,
  mapping: publicMappingSchema,
});

export type RepositoryAsanaContextData = z.output<typeof repositoryAsanaContextDataSchema>;

export interface RepositoryAsanaMappingProvider {
  find(identity: GitRepositoryIdentity): Promise<RepositoryAsanaMapping | undefined>;
}

export type FixedFileRepositoryAsanaMappingProviderOptions = Readonly<{
  path?: string;
  platform?: RepositoryAsanaMappingPlatform;
}>;

function mappingIdentity(identity: GitRepositoryIdentity): string {
  return `${identity.remote.host}\u0000${identity.repository.owner}\u0000${identity.repository.name}`;
}

export function parseRepositoryAsanaMappingFile(value: unknown): RepositoryAsanaMappingFile {
  const parsed = repositoryAsanaMappingFileSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid repository-to-Asana mapping");
  return parsed.data;
}

export function findRepositoryAsanaMapping(
  file: RepositoryAsanaMappingFile,
  identity: GitRepositoryIdentity,
): RepositoryAsanaMapping | undefined {
  const parsedIdentity = gitRepositoryIdentitySchema.parse(identity);
  return file.mappings.find(
    (entry) => mappingIdentity(entry) === mappingIdentity(parsedIdentity),
  );
}

function currentPlatform(): RepositoryAsanaMappingPlatform {
  return assertSupportedRuntimePlatform();
}

/** Returns the sole host-administered repository-to-Asana mapping location. */
export function fixedRepositoryAsanaMappingPath(
  platform: RepositoryAsanaMappingPlatform = currentPlatform(),
): string {
  return join(
    platform === "darwin" ? DARWIN_MAPPING_ROOT : LINUX_MAPPING_ROOT,
    "asana-cli",
    "repository-asana-mapping.json",
  );
}

function posixMappingPath(mappingRoot: string, path: string): {
  readonly directories: readonly string[];
  readonly path: string;
} {
  const normalizedPath = resolve(path);
  const pathBelowMappingRoot = relative(mappingRoot, normalizedPath);
  if (
    pathBelowMappingRoot.length === 0 ||
    pathBelowMappingRoot === ".." ||
    pathBelowMappingRoot.startsWith("../")
  ) {
    throw new Error("Untrusted repository mapping path");
  }

  const components = pathBelowMappingRoot.split("/");
  let directory = mappingRoot;
  const directories = [directory];
  for (const component of components.slice(0, -1)) {
    directory = join(directory, component);
    directories.push(directory);
  }
  return { directories, path: normalizedPath };
}

async function validateTrustedPosixDirectory(path: string): Promise<void> {
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await directory.stat();
    if (
      !metadata.isDirectory() ||
      metadata.uid !== 0 ||
      (metadata.mode & GROUP_OR_OTHER_WRITABLE) !== 0
    ) {
      throw new Error("Untrusted repository mapping directory");
    }
  } finally {
    await directory.close();
  }
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

async function readTrustedPosixMapping(path: string, platform: RepositoryAsanaMappingPlatform): Promise<unknown | undefined> {
  const mappingRoot = platform === "darwin" ? DARWIN_MAPPING_ROOT : LINUX_MAPPING_ROOT;
  const mapping = posixMappingPath(mappingRoot, path);
  for (const [index, directory] of mapping.directories.entries()) {
    try {
      await validateTrustedPosixDirectory(directory);
    } catch (error) {
      if (index === mapping.directories.length - 1 && errorCode(error) === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  let file;
  try {
    file = await open(mapping.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  try {
    const metadata = await file.stat();
    if (
      !metadata.isFile() ||
      metadata.uid !== 0 ||
      (metadata.mode & GROUP_OR_OTHER_WRITABLE) !== 0 ||
      metadata.size <= 0 ||
      metadata.size > MAX_MAPPING_BYTES
    ) {
      throw new Error("Untrusted repository mapping file");
    }

    const buffer = new Uint8Array(MAX_MAPPING_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, 0);
    if (bytesRead !== metadata.size || bytesRead === 0 || bytesRead > MAX_MAPPING_BYTES) {
      throw new Error("Repository mapping file changed while being read");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
    return JSON.parse(text);
  } finally {
    await file.close();
  }
}

function mappingNotFound(): CliError {
  return new CliError(
    "not-found",
    "No trusted repository-to-Asana mapping is configured for this repository",
  );
}

function mappingStorageInvalid(): CliError {
  return new CliError(
    "storage-invalid",
    "Trusted repository-to-Asana mapping is unavailable",
  );
}

/**
 * Loads the fixed host mapping only. It has no write-policy or agent-operation
 * integration; callers may use a successful lookup only as explicit read context.
 */
export class FixedFileRepositoryAsanaMappingProvider implements RepositoryAsanaMappingProvider {
  readonly path: string;
  readonly platform: RepositoryAsanaMappingPlatform;

  constructor(options: FixedFileRepositoryAsanaMappingProviderOptions = {}) {
    this.platform = options.platform ?? currentPlatform();
    this.path = options.path ?? fixedRepositoryAsanaMappingPath(this.platform);
  }

  async find(identity: GitRepositoryIdentity): Promise<RepositoryAsanaMapping | undefined> {
    const parsedIdentity = gitRepositoryIdentitySchema.safeParse(identity);
    if (!parsedIdentity.success) throw mappingNotFound();

    try {
      const value = await readTrustedPosixMapping(this.path, this.platform);
      if (value === undefined) throw mappingNotFound();
      const file = parseRepositoryAsanaMappingFile(value);
      return findRepositoryAsanaMapping(file, parsedIdentity.data);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw mappingStorageInvalid();
    }
  }
}
