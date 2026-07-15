import { z } from "zod";
import {
  taskPatchSchema,
  type prepareCommentInputSchema,
  type prepareTaskUpdateInputSchema,
} from "./agent-action-schemas";
import {
  addTaskComment,
  AGENT_USER_FIELDS,
  AGENT_TASK_FIELDS,
  getMe,
  getTask,
  STORY_FIELDS,
  updateTask,
} from "./asana-commands";
import { CliError } from "./errors";
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

const ownedTaskSchema = taskSchema.extend({
  modified_at: z.iso.datetime({ offset: true }),
  assignee: z.looseObject({
    gid: z.string().min(1),
    name: z.string().optional(),
  }).nullable().optional(),
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
]);

const appliedOperationViewSchema = z.strictObject({
  operation_id: z.uuid(),
  operation: z.enum(["task.update", "task.comment"]),
  state: z.literal("applied"),
  target: z.strictObject({ task_gid: z.string().min(1) }),
  result: z.strictObject({
    outcome: z.literal("applied"),
    resource_gid: z.string().min(1).optional(),
    resource_modified_at: z.string().min(1).optional(),
  }),
});

type PreparedOperationView = z.output<typeof preparedOperationViewSchema>;
type AppliedOperationView = z.output<typeof appliedOperationViewSchema>;
type PrepareCommentInput = z.output<typeof prepareCommentInputSchema>;
type PrepareTaskUpdateInput = z.output<typeof prepareTaskUpdateInputSchema>;

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
      "gid,name,modified_at,completed,due_on,due_at,start_on,assignee,assignee.gid,assignee.name,permalink_url",
    ),
  ]);
  return {
    user: parseExternalData(userResult, userSchema, "UsersApi.getUser"),
    task: parseExternalData(taskResult, ownedTaskSchema, "TasksApi.getTask"),
  };
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
  record: OperationRecord,
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
): Promise<void> {
  try {
    await repository.compareAndSet({
      id: record.id,
      expected_state: "applying",
      next_state: "unknown",
      metadata: { error_code: "APPLY_FAILED" },
    });
  } catch {
    // The remote request already began. A storage failure cannot make retry safe.
  }
}

export class AgentOperationService {
  readonly #client: AsanaClient;
  readonly #repository: OperationRepository;

  constructor(client: AsanaClient, repository: OperationRepository) {
    this.#client = client;
    this.#repository = repository;
  }

  async prepareTaskUpdate(input: PrepareTaskUpdateInput): Promise<PreparedOperationView> {
    ensureNoRegisteredSecret(input.patch, "Update");
    const { user, task } = await currentTaskContext(this.#client, input.task_gid);
    assertTaskOwnedByCurrentUser(user.gid, task.assignee?.gid);
    const record = await this.#repository.create({
      operation: "task.update",
      target: { task_gid: input.task_gid },
      payload: { changes: input.patch },
      guards: {
        expected_modified_at: task.modified_at,
        prepared_by_gid: user.gid,
      },
    });
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
    const record = await this.#repository.create({
      operation: "task.comment",
      target: { task_gid: input.task_gid },
      payload: { text: input.text },
      guards: {
        expected_modified_at: task.modified_at,
        prepared_by_gid: user.gid,
      },
    });
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

  async apply(operationId: string): Promise<AppliedOperationView> {
    const record = await requirePreparedOperation(this.#repository, operationId);
    ensureNoRegisteredSecret(record.payload, "Apply");
    const { user, task } = await currentTaskContext(this.#client, record.target.task_gid);
    assertApplyGuards(record, user.gid, task);

    const claim = await this.#repository.compareAndSet({
      id: record.id,
      expected_state: "prepared",
      next_state: "applying",
    });
    if (!claim.updated) throw operationStateError(claim.record);

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
      return candidate;
    } catch {
      await bestEffortMarkUnknown(this.#repository, record);
      throw unknownResultError(record);
    }
  }

  async #invoke(record: OperationRecord): Promise<{
    outcome: "applied";
    resource_gid?: string;
    resource_modified_at?: string;
  }> {
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
