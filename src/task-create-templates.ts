import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  customFieldValueSchema,
  taskCreateOverridesSchema,
  taskCreateTemplateMetadataSchema,
} from "./agent-action-schemas";
import { CliError } from "./errors";
import { readCurrentRepositoryRoot } from "./git-context";
import {
  FixedFileRepositoryContextManifestProvider,
  parseRepositoryContextJson,
  projectAliasSchema,
  type RepositoryContextManifestProvider,
} from "./repository-context";
import { gidSchema } from "./schemas";

export const MAX_TASK_CREATE_TEMPLATE_BYTES = 49_152;
export const MAX_TASK_CREATE_TEMPLATES = 50;

const templateCustomFieldSchema = z.strictObject({
  alias: projectAliasSchema,
  value: customFieldValueSchema,
});

const templateDefaultsSchema = z.strictObject({
  name: z.string().min(1).max(500).optional(),
  notes: z.string().max(8_000).optional(),
  due_on: z.iso.date().optional(),
  due_at: z.iso.datetime({ offset: true }).optional(),
  start_on: z.iso.date().optional(),
  custom_fields: z.array(templateCustomFieldSchema).max(50).optional(),
}).superRefine((defaults, context) => {
  if (defaults.due_on !== undefined && defaults.due_at !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["due_at"],
      message: "template defaults cannot set due_on and due_at together",
    });
  }
  if (
    defaults.start_on !== undefined &&
    defaults.due_on === undefined &&
    defaults.due_at === undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["start_on"],
      message: "template start_on requires due_on or due_at",
    });
  }
  const aliases = new Set<string>();
  for (const [index, field] of (defaults.custom_fields ?? []).entries()) {
    if (aliases.has(field.alias)) {
      context.addIssue({
        code: "custom",
        path: ["custom_fields", index, "alias"],
        message: "template custom-field aliases must be unique",
      });
    }
    aliases.add(field.alias);
  }
});

const taskCreateTemplateSchema = z.strictObject({
  alias: projectAliasSchema,
  revision: z.number().int().min(1).max(2_147_483_647),
  project_alias: projectAliasSchema,
  defaults: templateDefaultsSchema,
});

export const taskCreateTemplateManifestSchema = z.strictObject({
  schema: z.literal("asana-cli.task-create-templates.v1"),
  templates: z.array(taskCreateTemplateSchema)
    .min(1)
    .max(MAX_TASK_CREATE_TEMPLATES),
}).superRefine((manifest, context) => {
  const aliases = new Set<string>();
  for (const [index, template] of manifest.templates.entries()) {
    if (aliases.has(template.alias)) {
      context.addIssue({
        code: "custom",
        path: ["templates", index, "alias"],
        message: "task-create template aliases must be unique",
      });
    }
    aliases.add(template.alias);
  }
});

export type TaskCreateTemplateManifest = z.output<typeof taskCreateTemplateManifestSchema>;
export type TaskCreateTemplate = z.output<typeof taskCreateTemplateSchema>;

export const resolvedTaskCreateTemplateSchema = z.strictObject({
  metadata: taskCreateTemplateMetadataSchema,
  workspace_gid: gidSchema,
  project_gid: gidSchema,
  defaults: taskCreateOverridesSchema,
});

export type ResolvedTaskCreateTemplate = z.output<typeof resolvedTaskCreateTemplateSchema>;

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  throw new Error("Unsupported task-create template digest value");
}

export function computeTaskCreateTemplateDigest(
  template: TaskCreateTemplate,
): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJson({
      schema: "asana-cli.task-create-templates.v1",
      template,
    }), "utf8")
    .digest("hex")}`;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function readFixedTemplateManifest(root: string): Promise<string | undefined> {
  let directory;
  try {
    directory = await lstat(join(root, ".asana-cli"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error("Unsafe task-create template directory");
  }

  const path = join(root, ".asana-cli", "task-create-templates.json");
  let initial;
  try {
    initial = await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (
    !initial.isFile() ||
    initial.isSymbolicLink() ||
    initial.size <= 0 ||
    initial.size > MAX_TASK_CREATE_TEMPLATE_BYTES
  ) {
    throw new Error("Unsafe task-create template file");
  }

  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (
      !metadata.isFile() ||
      metadata.size !== initial.size ||
      metadata.size <= 0 ||
      metadata.size > MAX_TASK_CREATE_TEMPLATE_BYTES
    ) {
      throw new Error("Task-create template changed while opening");
    }
    const buffer = new Uint8Array(MAX_TASK_CREATE_TEMPLATE_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, 0);
    if (
      bytesRead !== metadata.size ||
      bytesRead !== initial.size ||
      bytesRead === 0 ||
      bytesRead > MAX_TASK_CREATE_TEMPLATE_BYTES
    ) {
      throw new Error("Task-create template changed while reading");
    }
    return new TextDecoder("utf-8", { fatal: true })
      .decode(buffer.subarray(0, bytesRead));
  } finally {
    await file.close();
  }
}

export interface TaskCreateTemplateProvider {
  resolve(alias: string, revision: number): Promise<ResolvedTaskCreateTemplate>;
}

export type FixedFileTaskCreateTemplateProviderOptions = Readonly<{
  repositoryContext?: RepositoryContextManifestProvider;
}>;

export class FixedFileTaskCreateTemplateProvider implements TaskCreateTemplateProvider {
  readonly #repositoryContext: RepositoryContextManifestProvider;

  constructor(options: FixedFileTaskCreateTemplateProviderOptions = {}) {
    this.#repositoryContext = options.repositoryContext ??
      new FixedFileRepositoryContextManifestProvider();
  }

  async resolve(alias: string, revision: number): Promise<ResolvedTaskCreateTemplate> {
    const parsedAlias = projectAliasSchema.parse(alias);
    const parsedRevision = z.number().int().min(1).max(2_147_483_647).parse(revision);
    let root: string;
    try {
      root = await readCurrentRepositoryRoot();
    } catch {
      throw new CliError("not-found", "Task-create template is unavailable");
    }

    try {
      const [context, source] = await Promise.all([
        this.#repositoryContext.load(),
        readFixedTemplateManifest(root),
      ]);
      if (source === undefined) {
        throw new CliError("not-found", "Task-create template is unavailable");
      }
      const manifest = taskCreateTemplateManifestSchema.parse(
        parseRepositoryContextJson(source),
      );
      const template = manifest.templates.find((entry) => entry.alias === parsedAlias);
      if (!template) {
        throw new CliError("not-found", "Task-create template is unavailable");
      }
      if (template.revision !== parsedRevision) {
        throw new CliError(
          "stale",
          "Task-create template revision changed; inspect and prepare again",
          undefined,
          {
            template: parsedAlias,
            expected_revision: parsedRevision,
            actual_revision: template.revision,
          },
        );
      }
      const project = context.projects.find(
        (entry) => entry.alias === template.project_alias,
      );
      if (!project) {
        throw new CliError(
          "stale",
          "Task-create template references missing repository context",
        );
      }
      const customFields = Object.fromEntries(
        (template.defaults.custom_fields ?? []).map((field) => {
          const mapped = context.custom_fields.find((entry) => entry.alias === field.alias);
          if (!mapped) {
            throw new CliError(
              "stale",
              "Task-create template references missing repository context",
            );
          }
          return [mapped.custom_field_gid, field.value];
        }),
      );
      const {
        custom_fields: _customFields,
        ...scalarDefaults
      } = template.defaults;
      return resolvedTaskCreateTemplateSchema.parse({
        metadata: {
          schema: manifest.schema,
          alias: template.alias,
          revision: template.revision,
          digest: computeTaskCreateTemplateDigest(template),
          context_revision: context.revision,
          context_digest: context.digest,
        },
        workspace_gid: context.workspace_gid,
        project_gid: project.project_gid,
        defaults: {
          ...scalarDefaults,
          ...(Object.keys(customFields).length === 0
            ? {}
            : { custom_fields: customFields }),
        },
      });
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError("storage-invalid", "Task-create template storage is invalid");
    }
  }
}
