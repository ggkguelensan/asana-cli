import { z } from "zod";
import { canonicalTaskReferenceSchema } from "./agent-action-schemas";
import { CliError, errorStatus } from "./errors";
import {
  FixedFileRepositoryContextManifestProvider,
  qualifiedTaskAliasSchema,
  repositoryContextDataSchema,
  type RepositoryContextManifestProvider,
} from "./repository-context";
import { gidSchema, parseExternalData } from "./schemas";
import { invokeApiMethod, type AsanaClient } from "./sdk";

const customIdSchema = z.string().regex(
  /^[A-Za-z0-9]{1,20}-[1-9][0-9]{0,63}$/,
  "Invalid Asana Custom ID",
);

const referenceKindSchema = z.enum([
  "gid",
  "url-v0",
  "url-v1",
  "custom-id",
  "repository-alias",
]);

const parsedTaskReferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("gid"),
    reference: z.string(),
    task_gid: gidSchema,
  }),
  z.strictObject({
    kind: z.literal("url-v0"),
    reference: z.string(),
    task_gid: gidSchema,
    project_gid: gidSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("url-v1"),
    reference: z.string(),
    task_gid: gidSchema,
    workspace_gid: gidSchema,
    project_gid: gidSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("custom-id"),
    reference: z.string(),
    workspace_gid: gidSchema,
    custom_id: customIdSchema,
  }),
  z.strictObject({
    kind: z.literal("repository-alias"),
    reference: qualifiedTaskAliasSchema,
    qualified_alias: qualifiedTaskAliasSchema,
  }),
]);

export type ParsedTaskReference = z.output<typeof parsedTaskReferenceSchema>;

const liveTaskSchema = z.looseObject({
  gid: gidSchema,
  workspace: z.looseObject({ gid: gidSchema }),
  memberships: z.array(z.looseObject({
    project: z.looseObject({ gid: gidSchema }).optional(),
  })).max(100).default([]),
});

const resolvedCustomTaskSchema = z.looseObject({
  gid: gidSchema,
});

const repositoryEvidenceSchema = z.strictObject({
  revision: z.number().int().min(1).max(2_147_483_647),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  qualified_alias: qualifiedTaskAliasSchema,
});

export const resolvedTaskReferenceDataSchema = z.strictObject({
  reference: z.string().min(1).max(1_024),
  reference_kind: referenceKindSchema,
  task: z.strictObject({ gid: gidSchema }),
  workspace_gid: gidSchema,
  project_gid: gidSchema.optional(),
  repository_context: repositoryEvidenceSchema.optional(),
});

function validationError(): CliError {
  return new CliError(
    "validation",
    "Task reference must use canonical gid:, url:, custom:<workspace>/<ID>, or task:<project>/<alias> syntax",
  );
}

/**
 * Parses only canonical reference forms. It performs no trimming, case folding,
 * URL decoding, search, title matching, or Git-token inference.
 */
export function parseTaskReference(reference: string): ParsedTaskReference {
  if (!canonicalTaskReferenceSchema.safeParse(reference).success) {
    throw validationError();
  }
  const gidMatch = /^gid:(\d{1,64})$/.exec(reference);
  if (gidMatch) {
    return parsedTaskReferenceSchema.parse({
      kind: "gid",
      reference,
      task_gid: gidMatch[1],
    });
  }

  const v0Match = /^url:https:\/\/app\.asana\.com\/0\/(0|\d{1,64})\/(\d{1,64})(?:\/f)?$/
    .exec(reference);
  if (v0Match) {
    return parsedTaskReferenceSchema.parse({
      kind: "url-v0",
      reference,
      task_gid: v0Match[2],
      ...(v0Match[1] === "0" ? {} : { project_gid: v0Match[1] }),
    });
  }

  const v1ProjectMatch =
    /^url:https:\/\/app\.asana\.com\/1\/(\d{1,64})\/project\/(\d{1,64})\/task\/(\d{1,64})$/
      .exec(reference);
  if (v1ProjectMatch) {
    return parsedTaskReferenceSchema.parse({
      kind: "url-v1",
      reference,
      workspace_gid: v1ProjectMatch[1],
      project_gid: v1ProjectMatch[2],
      task_gid: v1ProjectMatch[3],
    });
  }

  const v1TaskMatch =
    /^url:https:\/\/app\.asana\.com\/1\/(\d{1,64})\/task\/(\d{1,64})$/
      .exec(reference);
  if (v1TaskMatch) {
    return parsedTaskReferenceSchema.parse({
      kind: "url-v1",
      reference,
      workspace_gid: v1TaskMatch[1],
      task_gid: v1TaskMatch[2],
    });
  }

  const customMatch = /^custom:(\d{1,64})\/([A-Za-z0-9]{1,20}-[1-9][0-9]{0,63})$/
    .exec(reference);
  if (customMatch) {
    return parsedTaskReferenceSchema.parse({
      kind: "custom-id",
      reference,
      workspace_gid: customMatch[1],
      custom_id: customMatch[2],
    });
  }

  if (qualifiedTaskAliasSchema.safeParse(reference).success) {
    return parsedTaskReferenceSchema.parse({
      kind: "repository-alias",
      reference,
      qualified_alias: reference,
    });
  }

  throw validationError();
}

async function readLiveTask(
  client: AsanaClient,
  taskGid: string,
): Promise<z.output<typeof liveTaskSchema>> {
  const value = await invokeApiMethod(
    client,
    "TasksApi",
    "getTask",
    [
      taskGid,
      {
        opt_fields: [
          "gid",
          "workspace",
          "workspace.gid",
          "memberships",
          "memberships.project",
          "memberships.project.gid",
        ].join(","),
      },
    ],
  );
  const task = parseExternalData(value, liveTaskSchema, "TasksApi.getTask");
  if (task.gid !== taskGid) {
    throw new CliError("internal", "Invalid task identity from TasksApi.getTask");
  }
  return task;
}

function staleReference(reason: string): CliError {
  return new CliError("stale", "Task reference no longer matches live Asana state", undefined, {
    reason,
  });
}

function projectMembershipMatches(
  task: z.output<typeof liveTaskSchema>,
  projectGid: string,
): boolean {
  return task.memberships.some((membership) => membership.project?.gid === projectGid);
}

type ResolveTaskReferenceOptions = Readonly<{
  repositoryContext?: RepositoryContextManifestProvider;
}>;

/**
 * Resolves one exact reference and revalidates it against live Asana state.
 * Search results, titles and Git tokens are deliberately outside this resolver.
 */
export async function resolveTaskReference(
  client: AsanaClient,
  reference: string,
  options: ResolveTaskReferenceOptions = {},
): Promise<z.output<typeof resolvedTaskReferenceDataSchema>> {
  const parsed = parseTaskReference(reference);
  let taskGid: string;
  let expectedWorkspace: string | undefined;
  let expectedProject: string | undefined;
  let repositoryEvidence: z.output<typeof repositoryEvidenceSchema> | undefined;

  if (parsed.kind === "custom-id") {
    const value = await invokeApiMethod(
      client,
      "TasksApi",
      "getTaskForCustomID",
      [parsed.workspace_gid, parsed.custom_id],
    );
    const resolved = parseExternalData(
      value,
      resolvedCustomTaskSchema,
      "TasksApi.getTaskForCustomID",
    );
    taskGid = resolved.gid;
    expectedWorkspace = parsed.workspace_gid;
  } else if (parsed.kind === "repository-alias") {
    const provider = options.repositoryContext ??
      new FixedFileRepositoryContextManifestProvider();
    const context = repositoryContextDataSchema.parse(await provider.load());
    const matches = context.tasks.filter(
      (task) => task.qualified_alias === parsed.qualified_alias,
    );
    if (matches.length === 0) {
      throw new CliError("not-found", "Repository task alias is not defined");
    }
    if (matches.length > 1) {
      throw new CliError("ambiguous", "Repository task alias has multiple exact mappings", undefined, {
        match_count: Math.min(matches.length, 100),
      });
    }
    const match = matches[0]!;
    const project = context.projects.find(
      (candidate) => candidate.alias === match.project_alias,
    );
    if (!project) throw staleReference("mapped-project-missing");
    taskGid = match.task_gid;
    expectedWorkspace = context.workspace_gid;
    expectedProject = project.project_gid;
    repositoryEvidence = repositoryEvidenceSchema.parse({
      revision: context.revision,
      digest: context.digest,
      qualified_alias: match.qualified_alias,
    });
  } else {
    taskGid = parsed.task_gid;
    expectedWorkspace = "workspace_gid" in parsed ? parsed.workspace_gid : undefined;
    expectedProject = "project_gid" in parsed ? parsed.project_gid : undefined;
  }

  let liveTask: z.output<typeof liveTaskSchema>;
  try {
    liveTask = await readLiveTask(client, taskGid);
  } catch (error: unknown) {
    if (parsed.kind === "repository-alias" && errorStatus(error) === 404) {
      throw staleReference("task-missing");
    }
    throw error;
  }

  if (
    expectedWorkspace !== undefined &&
    liveTask.workspace.gid !== expectedWorkspace
  ) {
    throw staleReference("workspace-mismatch");
  }
  if (
    expectedProject !== undefined &&
    !projectMembershipMatches(liveTask, expectedProject)
  ) {
    throw staleReference("project-mismatch");
  }

  return resolvedTaskReferenceDataSchema.parse({
    reference,
    reference_kind: parsed.kind,
    task: { gid: taskGid },
    workspace_gid: liveTask.workspace.gid,
    ...(expectedProject === undefined ? {} : { project_gid: expectedProject }),
    ...(repositoryEvidence === undefined
      ? {}
      : { repository_context: repositoryEvidence }),
  });
}
