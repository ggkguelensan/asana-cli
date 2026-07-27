import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { normalizeError } from "../src/errors";
import {
  computeTaskCreateTemplateDigest,
  FixedFileTaskCreateTemplateProvider,
  taskCreateTemplateManifestSchema,
} from "../src/task-create-templates";
import { runGit } from "./support/git";
import { TemporaryDirectories } from "./support/temp";

const directories = new TemporaryDirectories();

function contextManifest(): Record<string, unknown> {
  return {
    schema: "asana-cli.repository-context.v1",
    revision: 7,
    workspace_gid: "100",
    mappings: [
      { kind: "project", alias: "platform", project_gid: "200" },
      { kind: "custom-field", alias: "priority", custom_field_gid: "300" },
    ],
  };
}

function templateManifest(): Record<string, unknown> {
  return {
    schema: "asana-cli.task-create-templates.v1",
    templates: [{
      alias: "feature",
      revision: 3,
      project_alias: "platform",
      defaults: {
        notes: "Static checklist",
        custom_fields: [{ alias: "priority", value: "ready" }],
      },
    }],
  };
}

async function git(directory: string, args: readonly string[]): Promise<void> {
  await runGit(directory, args);
}

async function repository(): Promise<string> {
  const root = await directories.create("asana-task-create-templates-");
  await git(root, ["init", "-q"]);
  await mkdir(join(root, ".asana-cli"));
  await writeFile(
    join(root, ".asana-cli", "repository-context.json"),
    JSON.stringify(contextManifest()),
  );
  await writeFile(
    join(root, ".asana-cli", "task-create-templates.json"),
    JSON.stringify(templateManifest()),
  );
  return root;
}

async function fromDirectory<Result>(
  directory: string,
  action: () => Promise<Result>,
): Promise<Result> {
  const previous = process.cwd();
  process.chdir(directory);
  try {
    return await action();
  } finally {
    process.chdir(previous);
  }
}

afterEach(async () => {
  await directories.cleanup();
});

describe("revisioned task-create templates", () => {
  test("accepts only bounded static defaults with unique exact aliases", () => {
    const parsed = taskCreateTemplateManifestSchema.parse(templateManifest());
    expect(computeTaskCreateTemplateDigest(parsed.templates[0]!))
      .toMatch(/^sha256:[0-9a-f]{64}$/);

    const invalid: readonly unknown[] = [
      { ...templateManifest(), schema: "asana-cli.task-create-templates.v2" },
      { ...templateManifest(), include: "other.json" },
      { ...templateManifest(), script: "echo unsafe" },
      { ...templateManifest(), environment: { NAME: "value" } },
      {
        ...templateManifest(),
        templates: [
          ...taskCreateTemplateManifestSchema.parse(templateManifest()).templates,
          ...taskCreateTemplateManifestSchema.parse(templateManifest()).templates,
        ],
      },
      {
        ...templateManifest(),
        templates: [{
          alias: "feature",
          revision: 3,
          project_alias: "platform",
          defaults: {
            custom_fields: [
              { alias: "priority", value: "one" },
              { alias: "priority", value: "two" },
            ],
          },
        }],
      },
      {
        ...templateManifest(),
        templates: [{
          alias: "feature",
          revision: 3,
          project_alias: "platform",
          defaults: {
            due_on: "2026-08-01",
            due_at: "2026-08-01T10:00:00Z",
          },
        }],
      },
      {
        ...templateManifest(),
        templates: [{
          alias: "feature",
          revision: 3,
          project_alias: "platform",
          defaults: {
            start_on: "2026-08-01",
          },
        }],
      },
    ];
    for (const value of invalid) {
      expect(taskCreateTemplateManifestSchema.safeParse(value).success).toBe(false);
    }
  });

  test("resolves exact revision and repository aliases to immutable GIDs", async () => {
    const root = await repository();
    const resolved = await fromDirectory(
      root,
      () => new FixedFileTaskCreateTemplateProvider().resolve("feature", 3),
    );
    expect(resolved).toMatchObject({
      metadata: {
        schema: "asana-cli.task-create-templates.v1",
        alias: "feature",
        revision: 3,
        context_revision: 7,
      },
      workspace_gid: "100",
      project_gid: "200",
      defaults: {
        notes: "Static checklist",
        custom_fields: { "300": "ready" },
      },
    });
    expect(resolved.metadata.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(resolved.metadata.context_digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const stale = await fromDirectory(root, async () => {
      try {
        await new FixedFileTaskCreateTemplateProvider().resolve("feature", 2);
      } catch (error) {
        return normalizeError(error);
      }
      throw new Error("Expected stale template");
    });
    expect(stale).toMatchObject({
      code: "stale",
      details: {
        template: "feature",
        expected_revision: 2,
        actual_revision: 3,
      },
    });
  });

  test("fails closed for missing mappings, malformed files, and linked manifests", async () => {
    const malformedRoot = await repository();
    await writeFile(
      join(malformedRoot, ".asana-cli", "task-create-templates.json"),
      '{"schema":"PRIVATE_TEMPLATE_CONTENT_CANARY"}',
    );
    const malformed = await fromDirectory(malformedRoot, async () => {
      try {
        await new FixedFileTaskCreateTemplateProvider().resolve("feature", 3);
      } catch (error) {
        return normalizeError(error);
      }
      throw new Error("Expected invalid template storage");
    });
    expect(malformed).toMatchObject({
      code: "storage-invalid",
      message: "Task-create template storage is invalid",
    });
    expect(JSON.stringify(malformed)).not.toContain("PRIVATE_TEMPLATE_CONTENT_CANARY");

    const linkedRoot = await repository();
    const path = join(linkedRoot, ".asana-cli", "task-create-templates.json");
    const target = join(linkedRoot, "linked-template.json");
    await rm(path);
    await writeFile(target, JSON.stringify(templateManifest()));
    await symlink(target, path);
    const linked = await fromDirectory(linkedRoot, async () => {
      try {
        await new FixedFileTaskCreateTemplateProvider().resolve("feature", 3);
      } catch (error) {
        return normalizeError(error);
      }
      throw new Error("Expected linked template rejection");
    });
    expect(linked.code).toBe("storage-invalid");

    const staleContextRoot = await repository();
    await writeFile(
      join(staleContextRoot, ".asana-cli", "repository-context.json"),
      JSON.stringify({
        ...contextManifest(),
        mappings: [{ kind: "project", alias: "other", project_gid: "201" }],
      }),
    );
    const staleContext = await fromDirectory(staleContextRoot, async () => {
      try {
        await new FixedFileTaskCreateTemplateProvider().resolve("feature", 3);
      } catch (error) {
        return normalizeError(error);
      }
      throw new Error("Expected stale context");
    });
    expect(staleContext.code).toBe("stale");
  });
});
