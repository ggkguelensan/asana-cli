import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CliError } from "./errors";
import { readCurrentRepositoryRoot } from "./git-context";
import { gidSchema } from "./schemas";

export const MAX_REPOSITORY_CONTEXT_BYTES = 49_152;

export const projectAliasSchema = z.string().regex(
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  "Invalid repository context alias",
);
const scopedAliasSchema = projectAliasSchema;
export const taskAliasSchema = z.string()
  .min(3)
  .max(96)
  .regex(
    /^(?:\d{1,64}|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)--[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    "Invalid repository context task alias",
  )
  .refine((value) => value.indexOf("--") === value.lastIndexOf("--"), {
    message: "Invalid repository context task alias",
  });

export const qualifiedTaskAliasSchema = z.string().superRefine((value, context) => {
  const match = /^task:([^/]+)\/(.+)$/.exec(value);
  if (
    !match ||
    !projectAliasSchema.safeParse(match[1]).success ||
    !taskAliasSchema.safeParse(match[2]).success
  ) {
    context.addIssue({ code: "custom", message: "Invalid qualified task alias" });
  }
});

const projectMappingSchema = z.strictObject({
  kind: z.literal("project"),
  alias: projectAliasSchema,
  project_gid: gidSchema,
});
const sectionMappingSchema = z.strictObject({
  kind: z.literal("section"),
  project_alias: projectAliasSchema,
  alias: scopedAliasSchema,
  section_gid: gidSchema,
});
const customFieldMappingSchema = z.strictObject({
  kind: z.literal("custom-field"),
  alias: scopedAliasSchema,
  custom_field_gid: gidSchema,
});
const taskMappingSchema = z.strictObject({
  kind: z.literal("task"),
  project_alias: projectAliasSchema,
  alias: taskAliasSchema,
  task_gid: gidSchema,
});

export const repositoryContextMappingSchema = z.discriminatedUnion("kind", [
  projectMappingSchema,
  sectionMappingSchema,
  customFieldMappingSchema,
  taskMappingSchema,
]);

type RepositoryContextMapping = z.output<typeof repositoryContextMappingSchema>;

function mappingSortKey(mapping: RepositoryContextMapping): string {
  switch (mapping.kind) {
    case "project":
      return `${mapping.kind}\u0000${mapping.alias}\u0000${mapping.project_gid}`;
    case "section":
      return `${mapping.kind}\u0000${mapping.project_alias}\u0000${mapping.alias}\u0000${mapping.section_gid}`;
    case "custom-field":
      return `${mapping.kind}\u0000${mapping.alias}\u0000${mapping.custom_field_gid}`;
    case "task":
      return `${mapping.kind}\u0000${mapping.project_alias}\u0000${mapping.alias}\u0000${mapping.task_gid}`;
  }
}

function compareRepositoryContextText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function contextDuplicate(
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

export const repositoryContextManifestSchema = z.strictObject({
  schema: z.literal("asana-cli.repository-context.v1"),
  revision: z.number().int().min(1).max(2_147_483_647),
  workspace_gid: gidSchema,
  mappings: z.array(repositoryContextMappingSchema).min(1).max(100),
}).superRefine((manifest, context) => {
  const projectAliases = new Set<string>();
  const projectGids = new Set<string>();
  const sectionLocators = new Set<string>();
  const sectionGids = new Set<string>();
  const customFieldAliases = new Set<string>();
  const customFieldGids = new Set<string>();
  const taskLocators = new Set<string>();

  for (const [index, mapping] of manifest.mappings.entries()) {
    switch (mapping.kind) {
      case "project":
        if (projectAliases.has(mapping.alias)) {
          contextDuplicate(context, ["mappings", index, "alias"], "Project aliases must be unique");
        }
        if (projectGids.has(mapping.project_gid)) {
          contextDuplicate(context, ["mappings", index, "project_gid"], "Project GIDs must be unique");
        }
        projectAliases.add(mapping.alias);
        projectGids.add(mapping.project_gid);
        break;
      case "section": {
        const locator = `${mapping.project_alias}\u0000${mapping.alias}`;
        if (sectionLocators.has(locator)) {
          contextDuplicate(context, ["mappings", index], "Section locators must be unique");
        }
        if (sectionGids.has(mapping.section_gid)) {
          contextDuplicate(context, ["mappings", index, "section_gid"], "Section GIDs must be unique");
        }
        sectionLocators.add(locator);
        sectionGids.add(mapping.section_gid);
        break;
      }
      case "custom-field":
        if (customFieldAliases.has(mapping.alias)) {
          contextDuplicate(context, ["mappings", index, "alias"], "Custom field aliases must be unique");
        }
        if (customFieldGids.has(mapping.custom_field_gid)) {
          contextDuplicate(context, ["mappings", index, "custom_field_gid"], "Custom field GIDs must be unique");
        }
        customFieldAliases.add(mapping.alias);
        customFieldGids.add(mapping.custom_field_gid);
        break;
      case "task": {
        const locator = `${mapping.project_alias}\u0000${mapping.alias}`;
        if (taskLocators.has(locator)) {
          contextDuplicate(context, ["mappings", index], "Task locators must be unique");
        }
        taskLocators.add(locator);
        break;
      }
    }
  }

  for (const [index, mapping] of manifest.mappings.entries()) {
    if (
      (mapping.kind === "section" || mapping.kind === "task") &&
      !projectAliases.has(mapping.project_alias)
    ) {
      contextDuplicate(context, ["mappings", index, "project_alias"], "Mapped project is missing");
    }
  }
});

export type RepositoryContextManifest = z.output<typeof repositoryContextManifestSchema>;

const repositoryContextDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const projectProjectionSchema = projectMappingSchema.omit({ kind: true });
const sectionProjectionSchema = sectionMappingSchema.omit({ kind: true });
const customFieldProjectionSchema = customFieldMappingSchema.omit({ kind: true });
const taskProjectionSchema = taskMappingSchema.omit({ kind: true }).extend({
  qualified_alias: qualifiedTaskAliasSchema,
});

export const repositoryContextDataSchema = z.strictObject({
  schema: z.literal("asana-cli.repository-context.v1"),
  revision: z.number().int().min(1).max(2_147_483_647),
  digest: repositoryContextDigestSchema,
  workspace_gid: gidSchema,
  projects: z.array(projectProjectionSchema).max(100),
  sections: z.array(sectionProjectionSchema).max(100),
  custom_fields: z.array(customFieldProjectionSchema).max(100),
  tasks: z.array(taskProjectionSchema).max(100),
});

export type RepositoryContextData = z.output<typeof repositoryContextDataSchema>;

class DuplicateKeyJsonParser {
  #index = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    this.skipWhitespace();
    const value = this.readValue();
    this.skipWhitespace();
    if (this.#index !== this.source.length) this.invalid();
    return value;
  }

  private invalid(): never {
    throw new Error("Invalid repository context JSON");
  }

  private skipWhitespace(): void {
    while (/[\u0020\u000a\u000d\u0009]/.test(this.source[this.#index] ?? "")) {
      this.#index += 1;
    }
  }

  private readValue(): unknown {
    switch (this.source[this.#index]) {
      case "{": return this.readObject();
      case "[": return this.readArray();
      case '"': return this.readString();
      case "t": return this.readLiteral("true", true);
      case "f": return this.readLiteral("false", false);
      case "n": return this.readLiteral("null", null);
      default:
        if (this.source[this.#index] === "-" || /[0-9]/.test(this.source[this.#index] ?? "")) {
          return this.readNumber();
        }
        return this.invalid();
    }
  }

  private readObject(): Record<string, unknown> {
    this.#index += 1;
    this.skipWhitespace();
    const result = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    if (this.source[this.#index] === "}") {
      this.#index += 1;
      return result;
    }
    for (;;) {
      if (this.source[this.#index] !== '"') this.invalid();
      const key = this.readString();
      if (key === "__proto__" || key === "constructor" || key === "prototype") this.invalid();
      if (keys.has(key)) this.invalid();
      keys.add(key);
      this.skipWhitespace();
      if (this.source[this.#index] !== ":") this.invalid();
      this.#index += 1;
      this.skipWhitespace();
      result[key] = this.readValue();
      this.skipWhitespace();
      if (this.source[this.#index] === "}") {
        this.#index += 1;
        return result;
      }
      if (this.source[this.#index] !== ",") this.invalid();
      this.#index += 1;
      this.skipWhitespace();
    }
  }

  private readArray(): unknown[] {
    this.#index += 1;
    this.skipWhitespace();
    const result: unknown[] = [];
    if (this.source[this.#index] === "]") {
      this.#index += 1;
      return result;
    }
    for (;;) {
      result.push(this.readValue());
      this.skipWhitespace();
      if (this.source[this.#index] === "]") {
        this.#index += 1;
        return result;
      }
      if (this.source[this.#index] !== ",") this.invalid();
      this.#index += 1;
      this.skipWhitespace();
    }
  }

  private readString(): string {
    if (this.source[this.#index] !== '"') this.invalid();
    this.#index += 1;
    let result = "";
    while (this.#index < this.source.length) {
      const character = this.source[this.#index++]!;
      if (character === '"') return result;
      if (character === "\\") {
        const escape = this.source[this.#index++];
        switch (escape) {
          case '"': result += '"'; break;
          case "\\": result += "\\"; break;
          case "/": result += "/"; break;
          case "b": result += "\b"; break;
          case "f": result += "\f"; break;
          case "n": result += "\n"; break;
          case "r": result += "\r"; break;
          case "t": result += "\t"; break;
          case "u": result += this.readUnicodeEscape(); break;
          default: this.invalid();
        }
      } else {
        if (character < " " || character === undefined) this.invalid();
        result += character;
      }
    }
    return this.invalid();
  }

  private readUnicodeEscape(): string {
    const hex = this.source.slice(this.#index, this.#index + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.invalid();
    this.#index += 4;
    const code = Number.parseInt(hex, 16);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (this.source.slice(this.#index, this.#index + 2) !== "\\u") this.invalid();
      this.#index += 2;
      const lowHex = this.source.slice(this.#index, this.#index + 4);
      if (!/^[0-9a-fA-F]{4}$/.test(lowHex)) this.invalid();
      this.#index += 4;
      const low = Number.parseInt(lowHex, 16);
      if (low < 0xdc00 || low > 0xdfff) this.invalid();
      return String.fromCodePoint(0x10000 + ((code - 0xd800) << 10) + low - 0xdc00);
    }
    if (code >= 0xdc00 && code <= 0xdfff) this.invalid();
    return String.fromCharCode(code);
  }

  private readLiteral(source: string, value: boolean | null): boolean | null {
    if (this.source.slice(this.#index, this.#index + source.length) !== source) this.invalid();
    this.#index += source.length;
    return value;
  }

  private readNumber(): number {
    const start = this.#index;
    if (this.source[this.#index] === "-") this.#index += 1;
    if (this.source[this.#index] === "0") {
      this.#index += 1;
    } else if (/[1-9]/.test(this.source[this.#index] ?? "")) {
      do this.#index += 1;
      while (/[0-9]/.test(this.source[this.#index] ?? ""));
    } else {
      this.invalid();
    }
    if (this.source[this.#index] === ".") {
      this.#index += 1;
      if (!/[0-9]/.test(this.source[this.#index] ?? "")) this.invalid();
      do this.#index += 1;
      while (/[0-9]/.test(this.source[this.#index] ?? ""));
    }
    if (this.source[this.#index] === "e" || this.source[this.#index] === "E") {
      this.#index += 1;
      if (this.source[this.#index] === "+" || this.source[this.#index] === "-") this.#index += 1;
      if (!/[0-9]/.test(this.source[this.#index] ?? "")) this.invalid();
      do this.#index += 1;
      while (/[0-9]/.test(this.source[this.#index] ?? ""));
    }
    const value = Number(this.source.slice(start, this.#index));
    if (!Number.isFinite(value)) this.invalid();
    return value;
  }
}

/** Parses bounded RFC-8259 JSON and rejects duplicate decoded object member names. */
export function parseRepositoryContextJson(source: string): unknown {
  return new DuplicateKeyJsonParser(source).parse();
}

export function parseRepositoryContextManifest(value: unknown): RepositoryContextManifest {
  return repositoryContextManifestSchema.parse(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new Error("Unsupported repository context digest value");
}

/** Computes the semantic manifest digest; formatting and mapping order do not affect it. */
export function computeRepositoryContextDigest(manifest: RepositoryContextManifest): string {
  const semantic = {
    schema: manifest.schema,
    revision: manifest.revision,
    workspace_gid: manifest.workspace_gid,
    mappings: [...manifest.mappings].sort((left, right) =>
      compareRepositoryContextText(mappingSortKey(left), mappingSortKey(right)),
    ),
  };
  return `sha256:${createHash("sha256").update(canonicalJson(semantic), "utf8").digest("hex")}`;
}

/** Produces the bounded, deterministic public context projection. */
export function projectRepositoryContext(manifest: RepositoryContextManifest): RepositoryContextData {
  const projects = manifest.mappings
    .filter((mapping): mapping is z.output<typeof projectMappingSchema> => mapping.kind === "project")
    .map(({ alias, project_gid }) => ({ alias, project_gid }))
    .sort((left, right) =>
      compareRepositoryContextText(left.alias, right.alias) ||
      compareRepositoryContextText(left.project_gid, right.project_gid),
    );
  const sections = manifest.mappings
    .filter((mapping): mapping is z.output<typeof sectionMappingSchema> => mapping.kind === "section")
    .map(({ project_alias, alias, section_gid }) => ({ project_alias, alias, section_gid }))
    .sort((left, right) =>
      compareRepositoryContextText(left.project_alias, right.project_alias) ||
      compareRepositoryContextText(left.alias, right.alias) ||
      compareRepositoryContextText(left.section_gid, right.section_gid),
    );
  const custom_fields = manifest.mappings
    .filter((mapping): mapping is z.output<typeof customFieldMappingSchema> => mapping.kind === "custom-field")
    .map(({ alias, custom_field_gid }) => ({ alias, custom_field_gid }))
    .sort((left, right) =>
      compareRepositoryContextText(left.alias, right.alias) ||
      compareRepositoryContextText(left.custom_field_gid, right.custom_field_gid),
    );
  const tasks = manifest.mappings
    .filter((mapping): mapping is z.output<typeof taskMappingSchema> => mapping.kind === "task")
    .map(({ project_alias, alias, task_gid }) => ({
      project_alias,
      alias,
      qualified_alias: `task:${project_alias}/${alias}`,
      task_gid,
    }))
    .sort((left, right) =>
      compareRepositoryContextText(left.project_alias, right.project_alias) ||
      compareRepositoryContextText(left.alias, right.alias) ||
      compareRepositoryContextText(left.task_gid, right.task_gid),
    );

  return repositoryContextDataSchema.parse({
    schema: manifest.schema,
    revision: manifest.revision,
    digest: computeRepositoryContextDigest(manifest),
    workspace_gid: manifest.workspace_gid,
    projects,
    sections,
    custom_fields,
    tasks,
  });
}

function repositoryContextNotFound(): CliError {
  return new CliError("not-found", "Repository context is unavailable");
}

function repositoryContextStorageInvalid(): CliError {
  return new CliError("storage-invalid", "Repository context storage is invalid");
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function readFixedRepositoryContext(path: string): Promise<string | undefined> {
  let directory;
  try {
    directory = await lstat(join(path, ".asana-cli"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error("Unsafe repository context directory");
  }

  const filePath = join(path, ".asana-cli", "repository-context.json");
  let initial;
  try {
    initial = await lstat(filePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (
    !initial.isFile() ||
    initial.isSymbolicLink() ||
    initial.size <= 0 ||
    initial.size > MAX_REPOSITORY_CONTEXT_BYTES
  ) {
    throw new Error("Unsafe repository context file");
  }

  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (
      !metadata.isFile() ||
      metadata.size !== initial.size ||
      metadata.size <= 0 ||
      metadata.size > MAX_REPOSITORY_CONTEXT_BYTES
    ) {
      throw new Error("Repository context changed while opening");
    }
    const buffer = new Uint8Array(MAX_REPOSITORY_CONTEXT_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, 0);
    if (bytesRead !== metadata.size || bytesRead !== initial.size || bytesRead === 0 || bytesRead > MAX_REPOSITORY_CONTEXT_BYTES) {
      throw new Error("Repository context changed while reading");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
  } finally {
    await file.close();
  }
}

export interface RepositoryContextManifestProvider {
  load(): Promise<RepositoryContextData>;
}

/** Loads the one untrusted, repository-controlled fixed-root context manifest. */
export class FixedFileRepositoryContextManifestProvider implements RepositoryContextManifestProvider {
  async load(): Promise<RepositoryContextData> {
    let root: string;
    try {
      root = await readCurrentRepositoryRoot();
    } catch {
      throw repositoryContextNotFound();
    }

    try {
      const source = await readFixedRepositoryContext(root);
      if (source === undefined) throw repositoryContextNotFound();
      return projectRepositoryContext(parseRepositoryContextManifest(parseRepositoryContextJson(source)));
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw repositoryContextStorageInvalid();
    }
  }
}
