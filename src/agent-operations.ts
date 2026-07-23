import { z } from "zod";
import {
  expandedTaskCreateFieldsSchema,
  taskCreateInputFieldsSchema,
  taskCreateTemplateMetadataSchema,
  taskPatchSchema,
  type prepareCommentInputSchema,
  type prepareSubtaskCreateInputSchema,
  type prepareTaskDependencyAddInputSchema,
  type prepareTaskDependencyRemoveInputSchema,
  type prepareTaskProjectAddInputSchema,
  type prepareTaskProjectRemoveInputSchema,
  type prepareTaskSectionMoveInputSchema,
  type prepareTaskFromTemplateInputSchema,
  type prepareTaskCreateInputSchema,
  type prepareTaskUpdateInputSchema,
} from "./agent-action-schemas";
import {
  addTaskDependency,
  addTaskComment,
  addTaskToProject,
  AGENT_USER_FIELDS,
  AGENT_TASK_FIELDS,
  createSubtask,
  createTask,
  getMe,
  getProject,
  getSection,
  getTask,
  moveTaskToSection,
  removeTaskDependency,
  removeTaskFromProject,
  STORY_FIELDS,
  updateTask,
} from "./asana-commands";
import { FileMetadataAuditStore } from "./audit/file-repository";
import type { MetadataAuditStore } from "./audit/repository";
import type { CreateMetadataAuditEventInput } from "./audit/schemas";
import { CliError } from "./errors";
import {
  assertDependencyAdditionAcyclic,
  assertDependencyAdditionWithinRelationLimits,
  readDirectDependencyGids,
} from "./dependency-safety";
import {
  FixedFileHostScopedWritePolicyProvider,
  type HostScopedWritePolicyProvider,
} from "./host-write-policy";
import type { OperationRepository } from "./operations/repository";
import type { OperationRecord } from "./operations/schemas";
import {
  parseExternalData,
  storySchema,
  taskSchema,
  userSchema,
} from "./schemas";
import type { AsanaClient } from "./sdk";
import { containsRegisteredSecret } from "./security";
import {
  FixedFileTaskCreateTemplateProvider,
  type TaskCreateTemplateProvider,
} from "./task-create-templates";
import {
  describeTaskCommentWrite,
  describeTaskCreateWrite,
  describeTaskDependencyWrite,
  describeTaskProjectWrite,
  describeTaskUpdateWrite,
  evaluateScopedWritePolicy,
} from "./write-policy";

const ownedTaskSchema = taskSchema.extend({
  modified_at: z.iso.datetime({ offset: true }),
  assignee: z.looseObject({
    gid: z.string().min(1),
    name: z.string().optional(),
  }).nullable().optional(),
  workspace: z.looseObject({
    gid: z.string().regex(/^\d{1,64}$/),
  }).optional(),
  memberships: z.array(z.looseObject({
    project: z.looseObject({
      gid: z.string().regex(/^\d{1,64}$/),
    }).optional(),
    section: z.looseObject({
      gid: z.string().regex(/^\d{1,64}$/),
    }).optional(),
  })).optional(),
});

const writableProjectSchema = z.looseObject({
  gid: z.string().regex(/^\d{1,64}$/),
  name: z.string().optional(),
  archived: z.boolean(),
  workspace: z.looseObject({
    gid: z.string().regex(/^\d{1,64}$/),
  }),
});

const writableSectionSchema = z.looseObject({
  gid: z.string().regex(/^\d{1,64}$/),
  name: z.string().optional(),
  project: z.looseObject({
    gid: z.string().regex(/^\d{1,64}$/),
  }),
});

const dependencyTaskSchema = z.looseObject({
  gid: z.string().regex(/^\d{1,64}$/),
  name: z.string().optional(),
  modified_at: z.iso.datetime({ offset: true }),
  permalink_url: z.string().optional(),
  workspace: z.looseObject({
    gid: z.string().regex(/^\d{1,64}$/),
  }),
});

const targetPreviewSchema = z.strictObject({
  gid: z.string().min(1),
  name: z.string().optional(),
  permalink_url: z.string().optional(),
});

const approvalSchema = z.strictObject({
  required: z.literal(true),
  reason: z.string().min(1),
});

const taskCreateTargetPreviewSchema = z.strictObject({
  workspace: z.strictObject({
    gid: z.string().regex(/^\d{1,64}$/),
    name: z.string().optional(),
  }),
  project: z.strictObject({
    gid: z.string().regex(/^\d{1,64}$/),
    name: z.string().optional(),
  }),
  parent: targetPreviewSchema.optional(),
});

const projectMutationPreviewSchema = z.strictObject({
  project: z.strictObject({
    gid: z.string().regex(/^\d{1,64}$/),
    name: z.string().optional(),
  }),
  section: z.strictObject({
    gid: z.string().regex(/^\d{1,64}$/),
    name: z.string().optional(),
  }).optional(),
});

const dependencyMutationPreviewSchema = z.strictObject({
  dependency: targetPreviewSchema,
});

const preparedOperationViewSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation_id: z.uuid(),
    operation: z.literal("task.update"),
    state: z.literal("prepared"),
    target: targetPreviewSchema,
    preview: z.strictObject({ changes: taskPatchSchema }),
    plan_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    expires_at: z.iso.datetime({ offset: true }),
    approval: approvalSchema,
  }),
  z.strictObject({
    operation_id: z.uuid(),
    operation: z.literal("task.comment"),
    state: z.literal("prepared"),
    target: targetPreviewSchema,
    preview: z.strictObject({ text: z.string().min(1).max(8_000) }),
    plan_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    expires_at: z.iso.datetime({ offset: true }),
    approval: approvalSchema,
  }),
  z.strictObject({
    operation_id: z.uuid(),
    operation: z.literal("task.create"),
    state: z.literal("prepared"),
    target: taskCreateTargetPreviewSchema,
    preview: z.strictObject({
      fields: expandedTaskCreateFieldsSchema,
    }),
    template: taskCreateTemplateMetadataSchema.optional(),
    plan_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    expires_at: z.iso.datetime({ offset: true }),
    approval: approvalSchema,
  }),
  z.strictObject({
    operation_id: z.uuid(),
    operation: z.literal("task.project.add"),
    state: z.literal("prepared"),
    target: targetPreviewSchema,
    preview: projectMutationPreviewSchema,
    plan_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    expires_at: z.iso.datetime({ offset: true }),
    approval: approvalSchema,
  }),
  z.strictObject({
    operation_id: z.uuid(),
    operation: z.literal("task.project.remove"),
    state: z.literal("prepared"),
    target: targetPreviewSchema,
    preview: projectMutationPreviewSchema,
    plan_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    expires_at: z.iso.datetime({ offset: true }),
    approval: approvalSchema,
  }),
  z.strictObject({
    operation_id: z.uuid(),
    operation: z.literal("task.section.move"),
    state: z.literal("prepared"),
    target: targetPreviewSchema,
    preview: projectMutationPreviewSchema,
    plan_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    expires_at: z.iso.datetime({ offset: true }),
    approval: approvalSchema,
  }),
  z.strictObject({
    operation_id: z.uuid(),
    operation: z.literal("task.dependency.add"),
    state: z.literal("prepared"),
    target: targetPreviewSchema,
    preview: dependencyMutationPreviewSchema,
    plan_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    expires_at: z.iso.datetime({ offset: true }),
    approval: approvalSchema,
  }),
  z.strictObject({
    operation_id: z.uuid(),
    operation: z.literal("task.dependency.remove"),
    state: z.literal("prepared"),
    target: targetPreviewSchema,
    preview: dependencyMutationPreviewSchema,
    plan_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    expires_at: z.iso.datetime({ offset: true }),
    approval: approvalSchema,
  }),
]);

const appliedOperationViewSchema = z.strictObject({
  operation_id: z.uuid(),
  operation: z.enum([
    "task.update",
    "task.comment",
    "task.create",
    "task.project.add",
    "task.project.remove",
    "task.section.move",
    "task.dependency.add",
    "task.dependency.remove",
  ]),
  state: z.literal("applied"),
  target: z.union([
    z.strictObject({ task_gid: z.string().min(1) }),
    z.strictObject({
      workspace_gid: z.string().regex(/^\d{1,64}$/),
      project_gid: z.string().regex(/^\d{1,64}$/),
      parent_task_gid: z.string().regex(/^\d{1,64}$/).optional(),
    }),
  ]),
  result: z.strictObject({
    outcome: z.literal("applied"),
    resource_gid: z.string().min(1).optional(),
    resource_modified_at: z.string().min(1).optional(),
  }),
});

type PreparedOperationView = z.output<typeof preparedOperationViewSchema>;
type AppliedOperationView = z.output<typeof appliedOperationViewSchema>;
type PrepareCommentInput = z.output<typeof prepareCommentInputSchema>;
type PrepareTaskCreateInput = z.output<typeof prepareTaskCreateInputSchema>;
type PrepareSubtaskCreateInput = z.output<typeof prepareSubtaskCreateInputSchema>;
type PrepareTaskDependencyAddInput = z.output<typeof prepareTaskDependencyAddInputSchema>;
type PrepareTaskDependencyRemoveInput = z.output<typeof prepareTaskDependencyRemoveInputSchema>;
type PrepareTaskProjectAddInput = z.output<typeof prepareTaskProjectAddInputSchema>;
type PrepareTaskProjectRemoveInput = z.output<typeof prepareTaskProjectRemoveInputSchema>;
type PrepareTaskSectionMoveInput = z.output<typeof prepareTaskSectionMoveInputSchema>;
type PrepareTaskFromTemplateInput = z.output<typeof prepareTaskFromTemplateInputSchema>;
type PrepareTaskUpdateInput = z.output<typeof prepareTaskUpdateInputSchema>;
type ExistingTaskOperationRecord = Exclude<
  OperationRecord,
  { operation: "task.create" }
>;
type TaskCreateOperationRecord = Extract<OperationRecord, { operation: "task.create" }>;
type ProjectMutationOperationRecord = Extract<
  OperationRecord,
  {
    operation:
      | "task.project.add"
      | "task.project.remove"
      | "task.section.move";
  }
>;
type DependencyMutationOperationRecord = Extract<
  OperationRecord,
  { operation: "task.dependency.add" | "task.dependency.remove" }
>;

function ensureNoRegisteredSecret(value: unknown, operation: string): void {
  if (containsRegisteredSecret(value)) {
    throw new CliError(
      "policy-denied",
      `${operation} blocked because it contains a credential from the local environment`,
    );
  }
}

async function currentTaskContext(
  client: AsanaClient,
  taskGid: string,
): Promise<{
  user: z.output<typeof userSchema>;
  task: z.output<typeof ownedTaskSchema>;
}> {
  const [userResult, taskResult] = await Promise.all([
    getMe(client, AGENT_USER_FIELDS),
    getTask(
      client,
      taskGid,
      "gid,name,modified_at,completed,due_on,due_at,start_on,assignee,assignee.gid,assignee.name,permalink_url,workspace,workspace.gid,memberships,memberships.project,memberships.project.gid,memberships.section,memberships.section.gid",
    ),
  ]);
  return {
    user: parseExternalData(userResult, userSchema, "UsersApi.getUser"),
    task: parseExternalData(taskResult, ownedTaskSchema, "TasksApi.getTask"),
  };
}

async function currentProjectContext(
  client: AsanaClient,
  projectGid: string,
): Promise<z.output<typeof writableProjectSchema>> {
  return parseExternalData(
    await getProject(client, projectGid, "gid,name,archived,workspace,workspace.gid"),
    writableProjectSchema,
    "ProjectsApi.getProject",
  );
}

async function currentSectionContext(
  client: AsanaClient,
  sectionGid: string,
): Promise<z.output<typeof writableSectionSchema>> {
  return parseExternalData(
    await getSection(client, sectionGid, "gid,name,project,project.gid"),
    writableSectionSchema,
    "SectionsApi.getSection",
  );
}

async function currentDependencyTaskContext(
  client: AsanaClient,
  taskGid: string,
): Promise<z.output<typeof dependencyTaskSchema>> {
  const task = parseExternalData(
    await getTask(
      client,
      taskGid,
      "gid,name,modified_at,permalink_url,workspace,workspace.gid",
    ),
    dependencyTaskSchema,
    "TasksApi.getTask",
  );
  if (task.gid !== taskGid) {
    throw new CliError(
      "internal",
      "Asana returned a different task than the exact dependency task requested",
    );
  }
  return task;
}

function taskProjectMembership(
  task: z.output<typeof ownedTaskSchema>,
  projectGid: string,
): NonNullable<z.output<typeof ownedTaskSchema>["memberships"]>[number] | undefined {
  return (task.memberships ?? []).find(
    (membership) => membership.project?.gid === projectGid,
  );
}

function assertSectionProject(
  section: z.output<typeof writableSectionSchema>,
  sectionGid: string,
  projectGid: string,
): void {
  if (section.gid !== sectionGid || section.project.gid !== projectGid) {
    throw new CliError(
      "stale",
      "The selected section does not belong to the selected project",
    );
  }
}

function assertCreateScope(
  user: z.output<typeof userSchema>,
  project: z.output<typeof writableProjectSchema>,
  workspaceGid: string,
  projectGid: string,
): void {
  if (
    user.workspaces?.some((workspace) => workspace.gid === workspaceGid) !== true ||
    project.gid !== projectGid ||
    project.workspace.gid !== workspaceGid ||
    project.archived
  ) {
    throw new CliError(
      "policy-denied",
      "Agent contract may create tasks only in an active, accessible project in the selected workspace",
    );
  }
}

function assertParentCreateScope(
  task: z.output<typeof ownedTaskSchema>,
  workspaceGid: string,
  projectGid: string,
): void {
  if (
    task.workspace?.gid !== workspaceGid ||
    !(task.memberships ?? []).some((membership) => membership.project?.gid === projectGid)
  ) {
    throw new CliError(
      "policy-denied",
      "The parent task is not in the selected workspace and project",
    );
  }
}

function assertTaskOwnedByCurrentUser(
  userGid: string,
  assigneeGid: string | undefined,
): void {
  if (assigneeGid !== userGid) {
    throw new CliError(
      "policy-denied",
      "Agent contract may update only tasks assigned to the authenticated user",
    );
  }
}

function assertApplyGuards(
  record: ExistingTaskOperationRecord,
  userGid: string,
  task: z.output<typeof ownedTaskSchema>,
): void {
  if (userGid !== record.guards.prepared_by_gid) {
    throw new CliError(
      "policy-denied",
      "Operation was prepared by a different authenticated Asana user",
    );
  }
  assertTaskOwnedByCurrentUser(userGid, task.assignee?.gid);
  if (task.modified_at !== record.guards.expected_modified_at) {
    throw new CliError(
      "stale",
      "Task changed after the operation was prepared; prepare a new operation",
    );
  }
}

function assertCreateApplyGuards(
  record: TaskCreateOperationRecord,
  userGid: string,
  parent: z.output<typeof ownedTaskSchema> | undefined,
): void {
  if (userGid !== record.guards.prepared_by_gid) {
    throw new CliError(
      "policy-denied",
      "Operation was prepared by a different authenticated Asana user",
    );
  }
  if (record.target.parent_task_gid === undefined) return;
  if (!parent || record.guards.expected_parent_modified_at !== parent.modified_at) {
    throw new CliError(
      "stale",
      "Parent task changed after the operation was prepared; prepare a new operation",
    );
  }
  assertTaskOwnedByCurrentUser(userGid, parent.assignee?.gid);
}

function operationStateError(record: OperationRecord): CliError {
  const details = {
    operation_id: record.id,
    operation: record.operation,
    state: record.state,
  };
  if (record.state === "expired") {
    return new CliError("expired", "Prepared operation has expired", undefined, details);
  }
  if (record.state === "applied") {
    return new CliError(
      "conflict",
      "Operation was already applied and will not be repeated",
      undefined,
      { ...details, reason: "already-applied" },
    );
  }
  if (record.state === "applying" || record.state === "unknown") {
    return new CliError(
      "unknown-result",
      "Operation may have reached Asana and will not be retried automatically",
      undefined,
      details,
    );
  }
  return new CliError("conflict", "Operation is not in a prepared state", undefined, details);
}

async function requirePreparedOperation(
  repository: OperationRepository,
  operationId: string,
): Promise<OperationRecord> {
  const record = await repository.get(operationId);
  if (!record) {
    throw new CliError("not-found", "Operation does not exist", undefined, {
      operation_id: operationId,
    });
  }
  if (record.state !== "prepared") throw operationStateError(record);
  return record;
}

function unknownResultError(record: OperationRecord): CliError {
  return new CliError(
    "unknown-result",
    "The Asana write may have succeeded; this operation will not be retried automatically",
    undefined,
    {
      operation_id: record.id,
      operation: record.operation,
      state: "unknown",
    },
  );
}

async function bestEffortMarkUnknown(
  repository: OperationRepository,
  record: OperationRecord,
): Promise<OperationRecord | undefined> {
  try {
    const result = await repository.compareAndSet({
      id: record.id,
      expected_state: "applying",
      next_state: "unknown",
      metadata: { error_code: "APPLY_FAILED" },
    });
    return result.updated ? result.record : undefined;
  } catch {
    // The remote request already began. A storage failure cannot make retry safe.
    return undefined;
  }
}

export type AgentOperationServiceOptions = Readonly<{
  writePolicy?: HostScopedWritePolicyProvider;
  audit?: MetadataAuditStore;
  taskCreateTemplates?: TaskCreateTemplateProvider;
}>;

export class AgentOperationService {
  readonly #client: AsanaClient;
  readonly #repository: OperationRepository;
  readonly #writePolicy: HostScopedWritePolicyProvider;
  readonly #audit: MetadataAuditStore;
  readonly #taskCreateTemplates: TaskCreateTemplateProvider;

  constructor(
    client: AsanaClient,
    repository: OperationRepository,
    options: AgentOperationServiceOptions = {},
  ) {
    this.#client = client;
    this.#repository = repository;
    this.#writePolicy = options.writePolicy ?? new FixedFileHostScopedWritePolicyProvider();
    this.#audit = options.audit ?? new FileMetadataAuditStore();
    this.#taskCreateTemplates = options.taskCreateTemplates ??
      new FixedFileTaskCreateTemplateProvider();
  }

  async prepareTaskUpdate(input: PrepareTaskUpdateInput): Promise<PreparedOperationView> {
    ensureNoRegisteredSecret(input.patch, "Update");
    const { user, task } = await currentTaskContext(this.#client, input.task_gid);
    assertTaskOwnedByCurrentUser(user.gid, task.assignee?.gid);
    await this.#assertWriteAllowed(task, "task.update", input.patch);
    const record = await this.#repository.create({
      operation: "task.update",
      target: { task_gid: input.task_gid },
      payload: { changes: input.patch },
      guards: {
        expected_modified_at: task.modified_at,
        prepared_by_gid: user.gid,
      },
    });
    await this.#appendAudit(record, { outcome: "prepared" });
    return preparedOperationViewSchema.parse({
      operation_id: record.id,
      operation: record.operation,
      state: record.state,
      target: { gid: task.gid, name: task.name, permalink_url: task.permalink_url },
      preview: { changes: input.patch },
      plan_hash: record.plan_hash,
      expires_at: record.expires_at,
      approval: { required: true, reason: "This operation modifies one Asana task." },
    });
  }

  async prepareComment(input: PrepareCommentInput): Promise<PreparedOperationView> {
    ensureNoRegisteredSecret(input.text, "Comment");
    const { user, task } = await currentTaskContext(this.#client, input.task_gid);
    assertTaskOwnedByCurrentUser(user.gid, task.assignee?.gid);
    await this.#assertWriteAllowed(task, "task.comment");
    const record = await this.#repository.create({
      operation: "task.comment",
      target: { task_gid: input.task_gid },
      payload: { text: input.text },
      guards: {
        expected_modified_at: task.modified_at,
        prepared_by_gid: user.gid,
      },
    });
    await this.#appendAudit(record, { outcome: "prepared" });
    return preparedOperationViewSchema.parse({
      operation_id: record.id,
      operation: record.operation,
      state: record.state,
      target: { gid: task.gid, name: task.name, permalink_url: task.permalink_url },
      preview: { text: input.text },
      plan_hash: record.plan_hash,
      expires_at: record.expires_at,
      approval: { required: true, reason: "This operation posts one Asana comment." },
    });
  }

  async prepareTaskCreate(input: PrepareTaskCreateInput): Promise<PreparedOperationView> {
    return this.#prepareTaskCreate(input);
  }

  async prepareTaskFromTemplate(
    input: PrepareTaskFromTemplateInput,
  ): Promise<PreparedOperationView> {
    ensureNoRegisteredSecret(input.task, "Task template overrides");
    const resolved = await this.#taskCreateTemplates.resolve(
      input.template,
      input.template_revision,
    );
    ensureNoRegisteredSecret(resolved.defaults, "Task template");
    const mergedCustomFields = {
      ...(resolved.defaults.custom_fields ?? {}),
      ...(input.task.custom_fields ?? {}),
    };
    const task = taskCreateInputFieldsSchema.parse({
      ...resolved.defaults,
      ...input.task,
      ...(Object.keys(mergedCustomFields).length === 0
        ? {}
        : { custom_fields: mergedCustomFields }),
    });
    return this.#prepareTaskCreate({
      workspace_gid: resolved.workspace_gid,
      project_gid: resolved.project_gid,
      task,
    }, resolved.metadata);
  }

  async #prepareTaskCreate(
    input: PrepareTaskCreateInput,
    template?: z.output<typeof taskCreateTemplateMetadataSchema>,
  ): Promise<PreparedOperationView> {
    ensureNoRegisteredSecret(input.task, "Task creation");
    const [userResult, project] = await Promise.all([
      getMe(this.#client, AGENT_USER_FIELDS),
      currentProjectContext(this.#client, input.project_gid),
    ]);
    const user = parseExternalData(userResult, userSchema, "UsersApi.getUser");
    assertCreateScope(user, project, input.workspace_gid, input.project_gid);
    const fields = expandedTaskCreateFieldsSchema.parse({
      ...input.task,
      assignee_gid: user.gid,
    });
    await this.#assertTaskCreateAllowed(input.workspace_gid, input.project_gid, fields);
    const record = await this.#repository.create({
      operation: "task.create",
      target: {
        workspace_gid: input.workspace_gid,
        project_gid: input.project_gid,
      },
      payload: {
        fields,
        ...(template === undefined ? {} : { template }),
      },
      guards: { prepared_by_gid: user.gid },
    });
    await this.#appendAudit(record, { outcome: "prepared" });
    const workspace = user.workspaces?.find((entry) => entry.gid === input.workspace_gid);
    return preparedOperationViewSchema.parse({
      operation_id: record.id,
      operation: record.operation,
      state: record.state,
      target: {
        workspace: { gid: input.workspace_gid, name: workspace?.name },
        project: { gid: project.gid, name: project.name },
      },
      preview: { fields },
      ...(template === undefined ? {} : { template }),
      plan_hash: record.plan_hash,
      expires_at: record.expires_at,
      approval: { required: true, reason: "This operation creates one Asana task." },
    });
  }

  async prepareSubtaskCreate(input: PrepareSubtaskCreateInput): Promise<PreparedOperationView> {
    ensureNoRegisteredSecret(input.task, "Subtask creation");
    const [{ user, task: parent }, project] = await Promise.all([
      currentTaskContext(this.#client, input.parent_task_gid),
      currentProjectContext(this.#client, input.project_gid),
    ]);
    assertTaskOwnedByCurrentUser(user.gid, parent.assignee?.gid);
    const workspaceGid = parent.workspace?.gid;
    if (!workspaceGid) {
      throw new CliError("policy-denied", "The parent task workspace is unavailable");
    }
    assertCreateScope(user, project, workspaceGid, input.project_gid);
    assertParentCreateScope(parent, workspaceGid, input.project_gid);
    const fields = expandedTaskCreateFieldsSchema.parse({
      ...input.task,
      assignee_gid: user.gid,
    });
    await this.#assertTaskCreateAllowed(workspaceGid, input.project_gid, fields);
    const record = await this.#repository.create({
      operation: "task.create",
      target: {
        workspace_gid: workspaceGid,
        project_gid: input.project_gid,
        parent_task_gid: parent.gid,
      },
      payload: { fields },
      guards: {
        prepared_by_gid: user.gid,
        expected_parent_modified_at: parent.modified_at,
      },
    });
    await this.#appendAudit(record, { outcome: "prepared" });
    const workspace = user.workspaces?.find((entry) => entry.gid === workspaceGid);
    return preparedOperationViewSchema.parse({
      operation_id: record.id,
      operation: record.operation,
      state: record.state,
      target: {
        workspace: { gid: workspaceGid, name: workspace?.name },
        project: { gid: project.gid, name: project.name },
        parent: {
          gid: parent.gid,
          name: parent.name,
          permalink_url: parent.permalink_url,
        },
      },
      preview: { fields },
      plan_hash: record.plan_hash,
      expires_at: record.expires_at,
      approval: { required: true, reason: "This operation creates one Asana subtask." },
    });
  }

  async prepareTaskProjectAdd(
    input: PrepareTaskProjectAddInput,
  ): Promise<PreparedOperationView> {
    const [{ user, task }, project, section] = await Promise.all([
      currentTaskContext(this.#client, input.task_gid),
      currentProjectContext(this.#client, input.project_gid),
      input.section_gid === undefined
        ? Promise.resolve(undefined)
        : currentSectionContext(this.#client, input.section_gid),
    ]);
    assertTaskOwnedByCurrentUser(user.gid, task.assignee?.gid);
    const workspaceGid = task.workspace?.gid;
    if (!workspaceGid) {
      throw new CliError("policy-denied", "The task workspace is unavailable");
    }
    assertCreateScope(user, project, workspaceGid, input.project_gid);
    if (section && input.section_gid) {
      assertSectionProject(section, input.section_gid, input.project_gid);
    }
    if (taskProjectMembership(task, input.project_gid)) {
      throw new CliError(
        "conflict",
        "The task already belongs to the selected project; use section move when needed",
      );
    }
    await this.#assertProjectMutationAllowed(
      "task.project.add",
      workspaceGid,
      input.project_gid,
    );
    const record = await this.#repository.create({
      operation: "task.project.add",
      target: { task_gid: input.task_gid },
      payload: {
        project_gid: input.project_gid,
        ...(input.section_gid === undefined ? {} : { section_gid: input.section_gid }),
      },
      guards: {
        expected_modified_at: task.modified_at,
        prepared_by_gid: user.gid,
      },
    });
    await this.#appendAudit(record, { outcome: "prepared" });
    return preparedOperationViewSchema.parse({
      operation_id: record.id,
      operation: record.operation,
      state: record.state,
      target: { gid: task.gid, name: task.name, permalink_url: task.permalink_url },
      preview: {
        project: { gid: project.gid, name: project.name },
        ...(section === undefined
          ? {}
          : { section: { gid: section.gid, name: section.name } }),
      },
      plan_hash: record.plan_hash,
      expires_at: record.expires_at,
      approval: {
        required: true,
        reason: "This operation adds one Asana task to one project.",
      },
    });
  }

  async prepareTaskProjectRemove(
    input: PrepareTaskProjectRemoveInput,
  ): Promise<PreparedOperationView> {
    const [{ user, task }, project] = await Promise.all([
      currentTaskContext(this.#client, input.task_gid),
      currentProjectContext(this.#client, input.project_gid),
    ]);
    assertTaskOwnedByCurrentUser(user.gid, task.assignee?.gid);
    const workspaceGid = task.workspace?.gid;
    if (!workspaceGid) {
      throw new CliError("policy-denied", "The task workspace is unavailable");
    }
    assertCreateScope(user, project, workspaceGid, input.project_gid);
    if (!taskProjectMembership(task, input.project_gid)) {
      throw new CliError("conflict", "The task does not belong to the selected project");
    }
    await this.#assertProjectMutationAllowed(
      "task.project.remove",
      workspaceGid,
      input.project_gid,
    );
    const record = await this.#repository.create({
      operation: "task.project.remove",
      target: { task_gid: input.task_gid },
      payload: { project_gid: input.project_gid },
      guards: {
        expected_modified_at: task.modified_at,
        prepared_by_gid: user.gid,
      },
    });
    await this.#appendAudit(record, { outcome: "prepared" });
    return preparedOperationViewSchema.parse({
      operation_id: record.id,
      operation: record.operation,
      state: record.state,
      target: { gid: task.gid, name: task.name, permalink_url: task.permalink_url },
      preview: { project: { gid: project.gid, name: project.name } },
      plan_hash: record.plan_hash,
      expires_at: record.expires_at,
      approval: {
        required: true,
        reason: "This operation removes one Asana task from one project.",
      },
    });
  }

  async prepareTaskSectionMove(
    input: PrepareTaskSectionMoveInput,
  ): Promise<PreparedOperationView> {
    const [{ user, task }, project, section] = await Promise.all([
      currentTaskContext(this.#client, input.task_gid),
      currentProjectContext(this.#client, input.project_gid),
      currentSectionContext(this.#client, input.section_gid),
    ]);
    assertTaskOwnedByCurrentUser(user.gid, task.assignee?.gid);
    const workspaceGid = task.workspace?.gid;
    if (!workspaceGid) {
      throw new CliError("policy-denied", "The task workspace is unavailable");
    }
    assertCreateScope(user, project, workspaceGid, input.project_gid);
    assertSectionProject(section, input.section_gid, input.project_gid);
    const membership = taskProjectMembership(task, input.project_gid);
    if (!membership) {
      throw new CliError("conflict", "The task does not belong to the selected project");
    }
    if (membership.section?.gid === input.section_gid) {
      throw new CliError("conflict", "The task is already in the selected section");
    }
    await this.#assertProjectMutationAllowed(
      "task.section.move",
      workspaceGid,
      input.project_gid,
    );
    const record = await this.#repository.create({
      operation: "task.section.move",
      target: { task_gid: input.task_gid },
      payload: {
        project_gid: input.project_gid,
        section_gid: input.section_gid,
      },
      guards: {
        expected_modified_at: task.modified_at,
        prepared_by_gid: user.gid,
      },
    });
    await this.#appendAudit(record, { outcome: "prepared" });
    return preparedOperationViewSchema.parse({
      operation_id: record.id,
      operation: record.operation,
      state: record.state,
      target: { gid: task.gid, name: task.name, permalink_url: task.permalink_url },
      preview: {
        project: { gid: project.gid, name: project.name },
        section: { gid: section.gid, name: section.name },
      },
      plan_hash: record.plan_hash,
      expires_at: record.expires_at,
      approval: {
        required: true,
        reason: "This operation moves one Asana task to one project section.",
      },
    });
  }

  async prepareTaskDependencyAdd(
    input: PrepareTaskDependencyAddInput,
  ): Promise<PreparedOperationView> {
    return this.#prepareTaskDependencyMutation(
      "task.dependency.add",
      input.task_gid,
      input.dependency_task_gid,
    );
  }

  async prepareTaskDependencyRemove(
    input: PrepareTaskDependencyRemoveInput,
  ): Promise<PreparedOperationView> {
    return this.#prepareTaskDependencyMutation(
      "task.dependency.remove",
      input.task_gid,
      input.dependency_task_gid,
    );
  }

  async #prepareTaskDependencyMutation(
    action: "task.dependency.add" | "task.dependency.remove",
    taskGid: string,
    dependencyTaskGid: string,
  ): Promise<PreparedOperationView> {
    const [{ user, task }, dependency] = await Promise.all([
      currentTaskContext(this.#client, taskGid),
      currentDependencyTaskContext(this.#client, dependencyTaskGid),
    ]);
    assertTaskOwnedByCurrentUser(user.gid, task.assignee?.gid);
    const workspaceGid = task.workspace?.gid;
    if (!workspaceGid || dependency.workspace.gid !== workspaceGid) {
      throw new CliError(
        "policy-denied",
        "Dependency operations require both tasks to be in the same accessible workspace",
      );
    }
    await this.#assertDependencyMutationAllowed(action, task);
    await this.#assertDependencyRelationState(
      action,
      taskGid,
      dependencyTaskGid,
      "conflict",
    );
    const record = await this.#repository.create({
      operation: action,
      target: { task_gid: taskGid },
      payload: { dependency_task_gid: dependencyTaskGid },
      guards: {
        expected_modified_at: task.modified_at,
        expected_dependency_modified_at: dependency.modified_at,
        prepared_by_gid: user.gid,
      },
    });
    await this.#appendAudit(record, { outcome: "prepared" });
    return preparedOperationViewSchema.parse({
      operation_id: record.id,
      operation: record.operation,
      state: record.state,
      target: { gid: task.gid, name: task.name, permalink_url: task.permalink_url },
      preview: {
        dependency: {
          gid: dependency.gid,
          name: dependency.name,
          permalink_url: dependency.permalink_url,
        },
      },
      plan_hash: record.plan_hash,
      expires_at: record.expires_at,
      approval: {
        required: true,
        reason: action === "task.dependency.add"
          ? "This operation adds one direct Asana task dependency."
          : "This operation removes one direct Asana task dependency.",
      },
    });
  }

  async apply(operationId: string): Promise<AppliedOperationView> {
    const record = await requirePreparedOperation(this.#repository, operationId);
    ensureNoRegisteredSecret(record.payload, "Apply");
    if (record.operation === "task.create") {
      const [userResult, project, parentResult] = await Promise.all([
        getMe(this.#client, AGENT_USER_FIELDS),
        currentProjectContext(this.#client, record.target.project_gid),
        record.target.parent_task_gid === undefined
          ? Promise.resolve(undefined)
          : getTask(
            this.#client,
            record.target.parent_task_gid,
            "gid,name,modified_at,assignee.gid,workspace.gid,memberships.project.gid",
          ),
      ]);
      const user = parseExternalData(userResult, userSchema, "UsersApi.getUser");
      const parent = parentResult === undefined
        ? undefined
        : parseExternalData(parentResult, ownedTaskSchema, "TasksApi.getTask");
      assertCreateScope(
        user,
        project,
        record.target.workspace_gid,
        record.target.project_gid,
      );
      assertCreateApplyGuards(record, user.gid, parent);
      if (parent) {
        assertParentCreateScope(
          parent,
          record.target.workspace_gid,
          record.target.project_gid,
        );
      }
      await this.#assertTaskCreateAllowed(
        record.target.workspace_gid,
        record.target.project_gid,
        record.payload.fields,
      );
    } else {
      const { user, task } = await currentTaskContext(this.#client, record.target.task_gid);
      assertApplyGuards(record, user.gid, task);
      if (record.operation === "task.update" || record.operation === "task.comment") {
        await this.#assertWriteAllowed(
          task,
          record.operation,
          record.operation === "task.update" ? record.payload.changes : undefined,
        );
      } else if (
        record.operation === "task.project.add" ||
        record.operation === "task.project.remove" ||
        record.operation === "task.section.move"
      ) {
        await this.#assertProjectMutationCurrent(record, user, task);
      } else {
        await this.#assertDependencyMutationCurrent(record, task);
      }
    }

    const claim = await this.#repository.compareAndSet({
      id: record.id,
      expected_state: "prepared",
      next_state: "applying",
    });
    if (!claim.updated) throw operationStateError(claim.record);
    await this.#appendApplyingAuditBeforeRemote(claim.record);

    try {
      const result = await this.#invoke(record);
      const candidate = appliedOperationViewSchema.parse({
        operation_id: record.id,
        operation: record.operation,
        state: "applied",
        target: record.target,
        result,
      });
      const completed = await this.#repository.compareAndSet({
        id: record.id,
        expected_state: "applying",
        next_state: "applied",
        metadata: {
          resource_gid: result.resource_gid,
          resource_modified_at: result.resource_modified_at,
        },
      });
      if (!completed.updated) throw operationStateError(completed.record);
      await this.#appendAuditAfterRemote(completed.record, {
        outcome: "applied",
        resource_gid: result.resource_gid,
        resource_modified_at: result.resource_modified_at,
      });
      return candidate;
    } catch {
      const unknown = await bestEffortMarkUnknown(this.#repository, record);
      if (unknown?.state === "unknown") {
        await this.#appendAuditAfterRemote(unknown, { outcome: "unknown" });
      }
      throw unknownResultError(record);
    }
  }

  async #assertWriteAllowed(
    task: z.output<typeof ownedTaskSchema>,
    action: "task.update" | "task.comment",
    patch?: unknown,
  ): Promise<void> {
    try {
      const target = {
        workspace_gid: task.workspace?.gid,
        project_gids: [...new Set(
          (task.memberships ?? []).flatMap((membership) =>
            membership.project === undefined ? [] : [membership.project.gid]
          ),
        )],
      };
      const candidate = action === "task.update"
        ? describeTaskUpdateWrite(target, patch)
        : describeTaskCommentWrite(target);
      const decision = evaluateScopedWritePolicy(await this.#writePolicy.load(), candidate);
      if (decision.allowed) return;
    } catch {
      // Malformed policy, malformed authoritative scope, and storage failures deny writes alike.
    }
    throw new CliError("policy-denied", "The host write policy does not permit this task operation");
  }

  async #assertTaskCreateAllowed(
    workspaceGid: string,
    projectGid: string,
    fields: unknown,
  ): Promise<void> {
    try {
      const candidate = describeTaskCreateWrite({
        workspace_gid: workspaceGid,
        project_gids: [projectGid],
      }, fields);
      const decision = evaluateScopedWritePolicy(await this.#writePolicy.load(), candidate);
      if (decision.allowed) return;
    } catch {
      // Malformed policy, malformed expanded fields, and storage failures deny writes alike.
    }
    throw new CliError("policy-denied", "The host write policy does not permit this task operation");
  }

  async #assertProjectMutationCurrent(
    record: ProjectMutationOperationRecord,
    user: z.output<typeof userSchema>,
    task: z.output<typeof ownedTaskSchema>,
  ): Promise<void> {
    const sectionGid = record.operation === "task.project.remove"
      ? undefined
      : record.payload.section_gid;
    const [project, section] = await Promise.all([
      currentProjectContext(this.#client, record.payload.project_gid),
      sectionGid === undefined
        ? Promise.resolve(undefined)
        : currentSectionContext(this.#client, sectionGid),
    ]);
    const workspaceGid = task.workspace?.gid;
    if (!workspaceGid) {
      throw new CliError("policy-denied", "The task workspace is unavailable");
    }
    assertCreateScope(user, project, workspaceGid, record.payload.project_gid);
    if (section && sectionGid) {
      assertSectionProject(section, sectionGid, record.payload.project_gid);
    }
    const membership = taskProjectMembership(task, record.payload.project_gid);
    if (record.operation === "task.project.add" && membership) {
      throw new CliError(
        "stale",
        "Task project membership changed after preparation; prepare a new operation",
      );
    }
    if (record.operation !== "task.project.add" && !membership) {
      throw new CliError(
        "stale",
        "Task project membership changed after preparation; prepare a new operation",
      );
    }
    if (
      record.operation === "task.section.move" &&
      membership?.section?.gid === record.payload.section_gid
    ) {
      throw new CliError(
        "stale",
        "Task section membership changed after preparation; prepare a new operation",
      );
    }
    await this.#assertProjectMutationAllowed(
      record.operation,
      workspaceGid,
      record.payload.project_gid,
    );
  }

  async #assertProjectMutationAllowed(
    action: "task.project.add" | "task.project.remove" | "task.section.move",
    workspaceGid: string,
    projectGid: string,
  ): Promise<void> {
    try {
      const candidate = describeTaskProjectWrite(action, {
        workspace_gid: workspaceGid,
        project_gids: [projectGid],
      });
      const decision = evaluateScopedWritePolicy(await this.#writePolicy.load(), candidate);
      if (decision.allowed) return;
    } catch {
      // Malformed policy, malformed authoritative scope, and storage failures deny writes alike.
    }
    throw new CliError(
      "policy-denied",
      "The host write policy does not permit this task project operation",
    );
  }

  async #assertDependencyMutationCurrent(
    record: DependencyMutationOperationRecord,
    task: z.output<typeof ownedTaskSchema>,
  ): Promise<void> {
    const dependency = await currentDependencyTaskContext(
      this.#client,
      record.payload.dependency_task_gid,
    );
    if (
      dependency.modified_at !== record.guards.expected_dependency_modified_at ||
      dependency.workspace.gid !== task.workspace?.gid
    ) {
      throw new CliError(
        "stale",
        "Dependency task changed after preparation; prepare a new operation",
      );
    }
    await this.#assertDependencyMutationAllowed(record.operation, task);
    await this.#assertDependencyRelationState(
      record.operation,
      record.target.task_gid,
      record.payload.dependency_task_gid,
      "stale",
    );
  }

  async #assertDependencyRelationState(
    action: "task.dependency.add" | "task.dependency.remove",
    taskGid: string,
    dependencyTaskGid: string,
    errorCode: "conflict" | "stale",
  ): Promise<void> {
    const dependencies = await readDirectDependencyGids(this.#client, taskGid);
    const relationExists = dependencies.includes(dependencyTaskGid);
    if (action === "task.dependency.add" && relationExists) {
      throw new CliError(
        errorCode,
        "The selected task is already a direct dependency",
      );
    }
    if (action === "task.dependency.remove" && !relationExists) {
      throw new CliError(
        errorCode,
        "The selected task is not a direct dependency",
      );
    }
    if (action === "task.dependency.add") {
      await Promise.all([
        assertDependencyAdditionAcyclic(this.#client, taskGid, dependencyTaskGid),
        assertDependencyAdditionWithinRelationLimits(
          this.#client,
          taskGid,
          dependencyTaskGid,
        ),
      ]);
    }
  }

  async #assertDependencyMutationAllowed(
    action: "task.dependency.add" | "task.dependency.remove",
    task: z.output<typeof ownedTaskSchema>,
  ): Promise<void> {
    try {
      const candidate = describeTaskDependencyWrite(action, {
        workspace_gid: task.workspace?.gid,
        project_gids: [...new Set(
          (task.memberships ?? []).flatMap((membership) =>
            membership.project === undefined ? [] : [membership.project.gid]
          ),
        )],
      });
      const decision = evaluateScopedWritePolicy(await this.#writePolicy.load(), candidate);
      if (decision.allowed) return;
    } catch {
      // Malformed policy, malformed authoritative scope, and storage failures deny writes alike.
    }
    throw new CliError(
      "policy-denied",
      "The host write policy does not permit task dependency operations",
    );
  }

  async #appendApplyingAuditBeforeRemote(record: OperationRecord): Promise<void> {
    try {
      await this.#appendAudit(record, { outcome: "applying" });
    } catch (error) {
      try {
        const rollback = await this.#repository.compareAndSet({
          id: record.id,
          expected_state: "applying",
          next_state: "prepared",
        });
        if (
          !rollback.updated
          || rollback.record.state !== "prepared"
          || rollback.record.attempt_started_at !== undefined
          || rollback.record.result !== undefined
        ) {
          throw new Error("Operation claim rollback did not restore prepared state");
        }
      } catch {
        throw new CliError(
          "storage-invalid",
          "Unable to restore the operation after required audit metadata persistence failed",
        );
      }
      throw error;
    }
  }

  async #appendAudit(
    record: OperationRecord,
    result: CreateMetadataAuditEventInput["result"],
  ): Promise<void> {
    try {
      await this.#audit.append({
        operation_id: record.id,
        target: record.operation === "task.create"
          ? { kind: "task-create", ...record.target }
          : { kind: "task", task_gid: record.target.task_gid },
        action: record.operation,
        plan_hash: record.plan_hash,
        record_hash: record.record_hash,
        result,
      });
    } catch {
      throw new CliError(
        "storage-invalid",
        "Unable to persist required audit metadata; the remote write was not started",
      );
    }
  }

  async #appendAuditAfterRemote(
    record: OperationRecord,
    result: CreateMetadataAuditEventInput["result"],
  ): Promise<void> {
    try {
      await this.#audit.append({
        operation_id: record.id,
        target: record.operation === "task.create"
          ? { kind: "task-create", ...record.target }
          : { kind: "task", task_gid: record.target.task_gid },
        action: record.operation,
        plan_hash: record.plan_hash,
        record_hash: record.record_hash,
        result,
      });
    } catch {
      // The remote call has already begun; reporting or retrying a storage failure is unsafe.
    }
  }

  async #invoke(record: OperationRecord): Promise<{
    outcome: "applied";
    resource_gid?: string;
    resource_modified_at?: string;
  }> {
    if (record.operation === "task.create") {
      const fields = expandedTaskCreateFieldsSchema.parse(record.payload.fields);
      const {
        assignee_gid: assignee,
        ...taskFields
      } = fields;
      const data = {
        ...taskFields,
        assignee,
        projects: [record.target.project_gid],
        ...(record.target.parent_task_gid === undefined
          ? { workspace: record.target.workspace_gid }
          : {}),
      };
      const created = parseExternalData(
        record.target.parent_task_gid === undefined
          ? await createTask(this.#client, data, AGENT_TASK_FIELDS)
          : await createSubtask(
            this.#client,
            record.target.parent_task_gid,
            data,
            AGENT_TASK_FIELDS,
          ),
        taskSchema,
        record.target.parent_task_gid === undefined
          ? "TasksApi.createTask"
          : "TasksApi.createSubtaskForTask",
      );
      return {
        outcome: "applied",
        resource_gid: created.gid,
        resource_modified_at: created.modified_at,
      };
    }
    if (record.operation === "task.project.add") {
      parseExternalData(
        await addTaskToProject(
          this.#client,
          record.target.task_gid,
          record.payload.project_gid,
          record.payload.section_gid,
        ),
        z.looseObject({}),
        "TasksApi.addProjectForTask",
      );
      return { outcome: "applied", resource_gid: record.target.task_gid };
    }
    if (record.operation === "task.project.remove") {
      parseExternalData(
        await removeTaskFromProject(
          this.#client,
          record.target.task_gid,
          record.payload.project_gid,
        ),
        z.looseObject({}),
        "TasksApi.removeProjectForTask",
      );
      return { outcome: "applied", resource_gid: record.target.task_gid };
    }
    if (record.operation === "task.section.move") {
      parseExternalData(
        await moveTaskToSection(
          this.#client,
          record.target.task_gid,
          record.payload.section_gid,
        ),
        z.looseObject({}),
        "SectionsApi.addTaskForSection",
      );
      return { outcome: "applied", resource_gid: record.target.task_gid };
    }
    if (record.operation === "task.dependency.add") {
      parseExternalData(
        await addTaskDependency(
          this.#client,
          record.target.task_gid,
          record.payload.dependency_task_gid,
        ),
        z.looseObject({}),
        "TasksApi.addDependenciesForTask",
      );
      return { outcome: "applied", resource_gid: record.target.task_gid };
    }
    if (record.operation === "task.dependency.remove") {
      parseExternalData(
        await removeTaskDependency(
          this.#client,
          record.target.task_gid,
          record.payload.dependency_task_gid,
        ),
        z.looseObject({}),
        "TasksApi.removeDependenciesForTask",
      );
      return { outcome: "applied", resource_gid: record.target.task_gid };
    }
    if (record.operation === "task.update") {
      const changes = taskPatchSchema.parse(record.payload.changes);
      const updated = parseExternalData(
        await updateTask(this.#client, record.target.task_gid, changes, AGENT_TASK_FIELDS),
        taskSchema,
        "TasksApi.updateTask",
      );
      return {
        outcome: "applied",
        resource_gid: updated.gid,
        resource_modified_at: updated.modified_at,
      };
    }
    const story = parseExternalData(
      await addTaskComment(
        this.#client,
        record.target.task_gid,
        { text: record.payload.text },
        STORY_FIELDS,
      ),
      storySchema,
      "StoriesApi.createStoryForTask",
    );
    return { outcome: "applied", resource_gid: story.gid };
  }
}
