import { z } from "zod";
import {
  applyOperationInputSchema,
  batchTasksInputSchema,
  findGitInputSchema,
  gitCurrentInputSchema,
  gitCurrentCandidatesInputSchema,
  getCustomFieldInputSchema,
  getTaskInputSchema,
  listCustomFieldsInputSchema,
  listCommentsInputSchema,
  listProjectMembershipsInputSchema,
  listProjectsInputSchema,
  listSectionsInputSchema,
  myTasksInputSchema,
  operationStatusInputSchema,
  prepareCommentInputSchema,
  prepareSubtaskCreateInputSchema,
  prepareTaskDependencyAddInputSchema,
  prepareTaskDependencyRemoveInputSchema,
  prepareTaskProjectAddInputSchema,
  prepareTaskProjectRemoveInputSchema,
  prepareTaskSectionMoveInputSchema,
  prepareTaskFromTemplateInputSchema,
  prepareTaskCreateInputSchema,
  prepareTaskUpdateInputSchema,
  repositoryAsanaInputSchema,
  repositoryContextInputSchema,
  resolveTaskInputSchema,
  resolveUserInputSchema,
  searchInputSchema,
  statusInputSchema,
  taskContextInputSchema,
} from "./agent-action-schemas";
import {
  batchTasksDataSchema,
} from "./batch-tasks";
import { repositoryAsanaContextDataSchema } from "./repository-asana-mapping";
import { repositoryContextDataSchema } from "./repository-context";
import { operationStatusProjectionSchema } from "./operations/status-projection";
import { gitContextSchema } from "./git-context";
import { gitCurrentCandidatesDataSchema, MAX_GIT_CURRENT_CANDIDATES } from "./git-current-candidates";
import {
  customFieldContextDataSchema,
  customFieldListContextDataSchema,
  MAX_CONTEXT_RESULTS,
  MAX_CUSTOM_FIELD_VALUES,
  projectListContextDataSchema,
  projectMembershipListContextDataSchema,
  resolvedUserContextDataSchema,
  sectionListContextDataSchema,
} from "./developer-context";
import { taskContextDataSchema } from "./task-context";
import { resolvedTaskReferenceDataSchema } from "./task-reference";
import { AGENT_ERROR_SCHEMA_ID, CliError, errorPayloadSchema } from "./errors";
import { readAgentJsonInput } from "./io";
import { jsonObjectSchema, zodIssueSummary } from "./schemas";
import { agentEnvelopeSchema } from "./security";
import {
  AGENT_PROTOCOL_COMPATIBILITY,
  AGENT_PROTOCOL_UPGRADE_GUIDANCE,
  AGENT_PROTOCOL_VERSION,
  CLI_VERSION,
} from "./version";

const MAX_AGENT_INPUT_BYTES = 65_536;
export const AGENT_ACTION_MINIMUM_CLI_VERSION = "0.2.0" as const;
export const AGENT_OPERATION_APPLY_MINIMUM_CLI_VERSION = "0.3.0" as const;

const policySchema = z.enum(["read", "read-write"]);
const effectSchema = z.enum(["read", "prepare", "write"]);
const approvalClassSchema = z.enum(["none", "external-host"]);

const actionLimitsSchema = z.strictObject({
  max_input_bytes: z.number().int().min(0),
  max_result_items: z.number().int().positive().optional(),
  max_content_bytes: z.number().int().nonnegative().optional(),
  max_text_chars: z.number().int().positive().optional(),
  max_custom_fields: z.number().int().positive().optional(),
});

export const agentActionDescriptorSchema = z.strictObject({
  action: z.string().regex(/^[a-z][a-z0-9-]*$/),
  operation: z.string().regex(/^[a-z][a-z0-9.-]*$/),
  effect: effectSchema,
  approval: approvalClassSchema,
  input_schema: z.string().min(1),
  output_schema: z.string().min(1),
  limits: actionLimitsSchema,
  minimum_cli_version: z.string().min(1),
  command: z.array(z.string().min(1)).min(1).optional(),
});

type ActionLimits = z.input<typeof actionLimitsSchema>;
type ActionEffect = z.input<typeof effectSchema>;
type ApprovalClass = z.input<typeof approvalClassSchema>;

function actionResultSchema<
  Operation extends string,
  Effect extends ActionEffect,
  DataSchema extends z.ZodType,
>(
  operation: Operation,
  effect: Effect,
  dataSchema: DataSchema,
) {
  return z.strictObject({
    operation: z.literal(operation),
    effect: z.literal(effect),
    policy: policySchema,
    data: dataSchema,
  });
}

type DescriptorSeed = {
  operation: string;
  effect: ActionEffect;
  approval: ApprovalClass;
  limits: ActionLimits;
  minimumCliVersion?: string;
  command?: readonly string[];
};

function defineAction<
  Action extends string,
  InputSchema extends z.ZodType,
>(
  action: Action,
  descriptor: DescriptorSeed,
  inputSchema: InputSchema,
  outputDataSchema: z.ZodType = z.unknown().nonoptional(),
) {
  const inputSchemaId = `asana-cli.agent.input.${action}.v${AGENT_PROTOCOL_VERSION}`;
  const outputSchemaId = `asana-cli.agent.output.${action}.v${AGENT_PROTOCOL_VERSION}`;
  const parsedDescriptor = agentActionDescriptorSchema.parse({
    action,
    operation: descriptor.operation,
    effect: descriptor.effect,
    approval: descriptor.approval,
    limits: descriptor.limits,
    input_schema: inputSchemaId,
    output_schema: outputSchemaId,
    minimum_cli_version:
      descriptor.minimumCliVersion ?? AGENT_ACTION_MINIMUM_CLI_VERSION,
    ...(descriptor.command === undefined ? {} : { command: [...descriptor.command] }),
  });
  const resultSchema = actionResultSchema(
    descriptor.operation,
    descriptor.effect,
    outputDataSchema,
  );
  return {
    descriptor: { ...parsedDescriptor, action },
    inputSchema,
    resultSchema,
    outputSchema: agentEnvelopeSchema(resultSchema),
  };
}

const statusAction = defineAction(
  "status",
  {
    operation: "auth.status",
    effect: "read",
    approval: "none",
    limits: { max_input_bytes: MAX_AGENT_INPUT_BYTES },
  },
  statusInputSchema,
);

const operationStatusAction = defineAction(
  "operation-status",
  {
    operation: "operation.status",
    effect: "read",
    approval: "none",
    limits: { max_input_bytes: MAX_AGENT_INPUT_BYTES },
    minimumCliVersion: AGENT_OPERATION_APPLY_MINIMUM_CLI_VERSION,
    command: ["operation", "status", "UUID"],
  },
  operationStatusInputSchema,
  operationStatusProjectionSchema,
);

const gitCurrentAction = defineAction(
  "git-current",
  {
    operation: "git.context.current",
    effect: "read",
    approval: "none",
    limits: { max_input_bytes: 0, max_result_items: 16 },
    command: ["context", "--git-current"],
  },
  gitCurrentInputSchema,
  gitContextSchema,
);

const repositoryAsanaAction = defineAction(
  "repository-asana",
  {
    operation: "repository.context.asana",
    effect: "read",
    approval: "none",
    limits: { max_input_bytes: 0, max_result_items: 1 },
    command: ["context", "--repository-asana"],
  },
  repositoryAsanaInputSchema,
  repositoryAsanaContextDataSchema,
);

const repositoryContextAction = defineAction(
  "repository-context",
  {
    operation: "repository.context.current",
    effect: "read",
    approval: "none",
    limits: { max_input_bytes: 0, max_result_items: 100 },
    minimumCliVersion: "0.5.0",
    command: ["context", "--repository-context"],
  },
  repositoryContextInputSchema,
  repositoryContextDataSchema,
);

const gitCurrentCandidatesAction = defineAction(
  "git-current-candidates",
  {
    operation: "git.context.current.candidates",
    effect: "read",
    approval: "none",
    limits: { max_input_bytes: 0, max_result_items: MAX_GIT_CURRENT_CANDIDATES },
    command: ["context", "--git-current-candidates"],
  },
  gitCurrentCandidatesInputSchema,
  gitCurrentCandidatesDataSchema,
);
const myTasksAction = defineAction(
  "my-tasks",
  {
    operation: "tasks.mine",
    effect: "read",
    approval: "none",
    limits: { max_input_bytes: MAX_AGENT_INPUT_BYTES, max_result_items: 500 },
  },
  myTasksInputSchema,
);

const listProjectsAction = defineAction(
  "list-projects",
  {
    operation: "projects.list",
    effect: "read",
    approval: "none",
    limits: { max_input_bytes: MAX_AGENT_INPUT_BYTES, max_result_items: MAX_CONTEXT_RESULTS },
    minimumCliVersion: "0.5.0",
  },
  listProjectsInputSchema,
  projectListContextDataSchema,
);

const listSectionsAction = defineAction(
  "list-sections",
  {
    operation: "sections.list",
    effect: "read",
    approval: "none",
    limits: { max_input_bytes: MAX_AGENT_INPUT_BYTES, max_result_items: MAX_CONTEXT_RESULTS },
    minimumCliVersion: "0.5.0",
  },
  listSectionsInputSchema,
  sectionListContextDataSchema,
);

const listProjectMembershipsAction = defineAction(
  "list-project-memberships",
  {
    operation: "project-memberships.list",
    effect: "read",
    approval: "none",
    limits: { max_input_bytes: MAX_AGENT_INPUT_BYTES, max_result_items: MAX_CONTEXT_RESULTS },
    minimumCliVersion: "0.5.0",
  },
  listProjectMembershipsInputSchema,
  projectMembershipListContextDataSchema,
);

const listCustomFieldsAction = defineAction(
  "list-custom-fields",
  {
    operation: "custom-fields.list",
    effect: "read",
    approval: "none",
    limits: { max_input_bytes: MAX_AGENT_INPUT_BYTES, max_result_items: MAX_CONTEXT_RESULTS },
    minimumCliVersion: "0.5.0",
  },
  listCustomFieldsInputSchema,
  customFieldListContextDataSchema,
);

const getCustomFieldAction = defineAction(
  "get-custom-field",
  {
    operation: "custom-field.get",
    effect: "read",
    approval: "none",
    limits: {
      max_input_bytes: MAX_AGENT_INPUT_BYTES,
      max_result_items: MAX_CUSTOM_FIELD_VALUES,
      max_content_bytes: 65_536,
    },
    minimumCliVersion: "0.5.0",
  },
  getCustomFieldInputSchema,
  customFieldContextDataSchema,
);

const resolveUserAction = defineAction(
  "resolve-user",
  {
    operation: "user.resolve",
    effect: "read",
    approval: "none",
    limits: { max_input_bytes: MAX_AGENT_INPUT_BYTES, max_result_items: 1 },
    minimumCliVersion: "0.5.0",
  },
  resolveUserInputSchema,
  resolvedUserContextDataSchema,
);

const taskContextAction = defineAction(
  "task-context",
  {
    operation: "task.context.get",
    effect: "read",
    approval: "none",
    limits: {
      max_input_bytes: 0,
      max_result_items: 400,
      max_content_bytes: 65_536,
    },
    minimumCliVersion: "0.5.0",
    command: ["context", "--task", "GID"],
  },
  taskContextInputSchema,
  taskContextDataSchema,
);

const batchTasksAction = defineAction(
  "batch-tasks",
  {
    operation: "tasks.batch.get",
    effect: "read",
    approval: "none",
    limits: {
      max_input_bytes: MAX_AGENT_INPUT_BYTES,
      max_result_items: 10,
      max_content_bytes: 65_536,
    },
    minimumCliVersion: "0.5.0",
  },
  batchTasksInputSchema,
  batchTasksDataSchema,
);

const resolveTaskAction = defineAction(
  "resolve-task",
  {
    operation: "task.reference.resolve",
    effect: "read",
    approval: "none",
    limits: { max_input_bytes: MAX_AGENT_INPUT_BYTES, max_result_items: 1 },
    minimumCliVersion: "0.5.0",
  },
  resolveTaskInputSchema,
  resolvedTaskReferenceDataSchema,
);

const getTaskAction = defineAction(
  "get-task",
  {
    operation: "task.get",
    effect: "read",
    approval: "none",
    limits: {
      max_input_bytes: MAX_AGENT_INPUT_BYTES,
      max_content_bytes: 65_536,
    },
  },
  getTaskInputSchema,
);

const listCommentsAction = defineAction(
  "list-comments",
  {
    operation: "task.comments",
    effect: "read",
    approval: "none",
    limits: {
      max_input_bytes: MAX_AGENT_INPUT_BYTES,
      max_result_items: 500,
      max_content_bytes: 65_536,
    },
  },
  listCommentsInputSchema,
);

const searchTasksAction = defineAction(
  "search-tasks",
  {
    operation: "task.search",
    effect: "read",
    approval: "none",
    limits: { max_input_bytes: MAX_AGENT_INPUT_BYTES, max_result_items: 100 },
  },
  searchInputSchema,
);

const findGitAction = defineAction(
  "find-git",
  {
    operation: "task.find-git",
    effect: "read",
    approval: "none",
    limits: { max_input_bytes: MAX_AGENT_INPUT_BYTES, max_result_items: 500 },
  },
  findGitInputSchema,
);

const prepareTaskUpdateAction = defineAction(
  "prepare-task-update",
  {
    operation: "task.update.prepare",
    effect: "prepare",
    approval: "none",
    limits: {
      max_input_bytes: MAX_AGENT_INPUT_BYTES,
      max_text_chars: 8_000,
      max_custom_fields: 50,
    },
    minimumCliVersion: AGENT_OPERATION_APPLY_MINIMUM_CLI_VERSION,
  },
  prepareTaskUpdateInputSchema,
);

const prepareCommentAction = defineAction(
  "prepare-comment",
  {
    operation: "task.comment.prepare",
    effect: "prepare",
    approval: "none",
    limits: { max_input_bytes: MAX_AGENT_INPUT_BYTES, max_text_chars: 8_000 },
    minimumCliVersion: AGENT_OPERATION_APPLY_MINIMUM_CLI_VERSION,
  },
  prepareCommentInputSchema,
);

const prepareTaskCreateAction = defineAction(
  "prepare-task-create",
  {
    operation: "task.create.prepare",
    effect: "prepare",
    approval: "none",
    limits: {
      max_input_bytes: MAX_AGENT_INPUT_BYTES,
      max_text_chars: 8_000,
      max_custom_fields: 50,
    },
    minimumCliVersion: "0.5.0",
  },
  prepareTaskCreateInputSchema,
);

const prepareSubtaskCreateAction = defineAction(
  "prepare-subtask-create",
  {
    operation: "subtask.create.prepare",
    effect: "prepare",
    approval: "none",
    limits: {
      max_input_bytes: MAX_AGENT_INPUT_BYTES,
      max_text_chars: 8_000,
      max_custom_fields: 50,
    },
    minimumCliVersion: "0.5.0",
  },
  prepareSubtaskCreateInputSchema,
);

const prepareTaskFromTemplateAction = defineAction(
  "prepare-task-from-template",
  {
    operation: "task.create-from-template.prepare",
    effect: "prepare",
    approval: "none",
    limits: {
      max_input_bytes: MAX_AGENT_INPUT_BYTES,
      max_text_chars: 8_000,
      max_custom_fields: 50,
    },
    minimumCliVersion: "0.5.0",
  },
  prepareTaskFromTemplateInputSchema,
);

const prepareTaskProjectAddAction = defineAction(
  "prepare-task-project-add",
  {
    operation: "task.project.add.prepare",
    effect: "prepare",
    approval: "none",
    limits: { max_input_bytes: MAX_AGENT_INPUT_BYTES },
    minimumCliVersion: "0.5.0",
  },
  prepareTaskProjectAddInputSchema,
);

const prepareTaskProjectRemoveAction = defineAction(
  "prepare-task-project-remove",
  {
    operation: "task.project.remove.prepare",
    effect: "prepare",
    approval: "none",
    limits: { max_input_bytes: MAX_AGENT_INPUT_BYTES },
    minimumCliVersion: "0.5.0",
  },
  prepareTaskProjectRemoveInputSchema,
);

const prepareTaskSectionMoveAction = defineAction(
  "prepare-task-section-move",
  {
    operation: "task.section.move.prepare",
    effect: "prepare",
    approval: "none",
    limits: { max_input_bytes: MAX_AGENT_INPUT_BYTES },
    minimumCliVersion: "0.5.0",
  },
  prepareTaskSectionMoveInputSchema,
);

const prepareTaskDependencyAddAction = defineAction(
  "prepare-task-dependency-add",
  {
    operation: "task.dependency.add.prepare",
    effect: "prepare",
    approval: "none",
    limits: { max_input_bytes: MAX_AGENT_INPUT_BYTES },
    minimumCliVersion: "0.5.0",
  },
  prepareTaskDependencyAddInputSchema,
);

const prepareTaskDependencyRemoveAction = defineAction(
  "prepare-task-dependency-remove",
  {
    operation: "task.dependency.remove.prepare",
    effect: "prepare",
    approval: "none",
    limits: { max_input_bytes: MAX_AGENT_INPUT_BYTES },
    minimumCliVersion: "0.5.0",
  },
  prepareTaskDependencyRemoveInputSchema,
);

const applyOperationAction = defineAction(
  "apply",
  {
    operation: "operation.apply",
    effect: "write",
    approval: "external-host",
    limits: { max_input_bytes: MAX_AGENT_INPUT_BYTES },
    minimumCliVersion: AGENT_OPERATION_APPLY_MINIMUM_CLI_VERSION,
  },
  applyOperationInputSchema,
);

export const AGENT_ACTIONS = {
  [statusAction.descriptor.action]: statusAction,
  [operationStatusAction.descriptor.action]: operationStatusAction,
  [myTasksAction.descriptor.action]: myTasksAction,
  [listProjectsAction.descriptor.action]: listProjectsAction,
  [listSectionsAction.descriptor.action]: listSectionsAction,
  [listProjectMembershipsAction.descriptor.action]: listProjectMembershipsAction,
  [listCustomFieldsAction.descriptor.action]: listCustomFieldsAction,
  [getCustomFieldAction.descriptor.action]: getCustomFieldAction,
  [resolveUserAction.descriptor.action]: resolveUserAction,
  [taskContextAction.descriptor.action]: taskContextAction,
  [batchTasksAction.descriptor.action]: batchTasksAction,
  [resolveTaskAction.descriptor.action]: resolveTaskAction,
  [gitCurrentAction.descriptor.action]: gitCurrentAction,
  [repositoryAsanaAction.descriptor.action]: repositoryAsanaAction,
  [repositoryContextAction.descriptor.action]: repositoryContextAction,
  [gitCurrentCandidatesAction.descriptor.action]: gitCurrentCandidatesAction,
  [getTaskAction.descriptor.action]: getTaskAction,
  [listCommentsAction.descriptor.action]: listCommentsAction,
  [searchTasksAction.descriptor.action]: searchTasksAction,
  [findGitAction.descriptor.action]: findGitAction,
  [prepareTaskUpdateAction.descriptor.action]: prepareTaskUpdateAction,
  [prepareCommentAction.descriptor.action]: prepareCommentAction,
  [prepareTaskCreateAction.descriptor.action]: prepareTaskCreateAction,
  [prepareSubtaskCreateAction.descriptor.action]: prepareSubtaskCreateAction,
  [prepareTaskFromTemplateAction.descriptor.action]: prepareTaskFromTemplateAction,
  [prepareTaskProjectAddAction.descriptor.action]: prepareTaskProjectAddAction,
  [prepareTaskProjectRemoveAction.descriptor.action]: prepareTaskProjectRemoveAction,
  [prepareTaskSectionMoveAction.descriptor.action]: prepareTaskSectionMoveAction,
  [prepareTaskDependencyAddAction.descriptor.action]: prepareTaskDependencyAddAction,
  [prepareTaskDependencyRemoveAction.descriptor.action]: prepareTaskDependencyRemoveAction,
  [applyOperationAction.descriptor.action]: applyOperationAction,
};

export type AgentActionName = keyof typeof AGENT_ACTIONS;
type AgentActionDefinition = (typeof AGENT_ACTIONS)[AgentActionName];
export type AgentActionInput<Action extends AgentActionName> =
  z.output<(typeof AGENT_ACTIONS)[Action]["inputSchema"]>;

export const AGENT_ACTION_NAMES = Object.keys(AGENT_ACTIONS) as AgentActionName[];

function agentActionDefinition(action: string): AgentActionDefinition | undefined {
  if (!Object.hasOwn(AGENT_ACTIONS, action)) return undefined;
  return AGENT_ACTIONS[action as AgentActionName];
}

export function agentActionDescriptor(
  action: string,
): z.output<typeof agentActionDescriptorSchema> | undefined {
  return agentActionDefinition(action)?.descriptor;
}

function requireAgentAction(action: string): AgentActionDefinition {
  const definition = agentActionDefinition(action);
  if (!definition) throw new CliError("usage", `Unknown agent action: ${action}`);
  return definition;
}

export function agentActionDescriptors(): z.output<typeof agentActionDescriptorSchema>[] {
  return AGENT_ACTION_NAMES.map((action) => AGENT_ACTIONS[action].descriptor);
}

export function agentActionInvocation(
  descriptor: z.output<typeof agentActionDescriptorSchema>,
): string {
  return `asana-cli agent ${(descriptor.command ?? [descriptor.action]).join(" ")}`;
}

export async function readAgentActionInput<Action extends AgentActionName>(
  value: string | undefined,
  action: Action,
): Promise<AgentActionInput<Action>> {
  const parsed = await readAgentJsonInput(value, AGENT_ACTIONS[action].inputSchema);
  return parsed as AgentActionInput<Action>;
}

export function parseAgentActionInput<Action extends AgentActionName>(
  value: unknown,
  action: Action,
): AgentActionInput<Action> {
  const parsed = AGENT_ACTIONS[action].inputSchema.safeParse(value);
  if (!parsed.success) {
    throw new CliError(
      "validation",
      `Agent input validation failed: ${zodIssueSummary(parsed.error)}`,
    );
  }
  return parsed.data as AgentActionInput<Action>;
}

export function createAgentActionResult(
  action: AgentActionName,
  policy: z.output<typeof policySchema>,
  data: unknown,
): unknown {
  const definition = AGENT_ACTIONS[action];
  return definition.resultSchema.parse({
    operation: definition.descriptor.operation,
    effect: definition.descriptor.effect,
    policy,
    data,
  });
}

function jsonSchemaDocument(id: string, schema: z.ZodType, io: "input" | "output") {
  const generated = z.toJSONSchema(schema, { io });
  return jsonObjectSchema.parse({ ...generated, $id: id });
}

const publishedAgentErrorSchema = jsonSchemaDocument(
  AGENT_ERROR_SCHEMA_ID,
  agentEnvelopeSchema(errorPayloadSchema),
  "output",
);

const publishedActionSchema = z.strictObject({
  descriptor: agentActionDescriptorSchema,
  input: jsonObjectSchema,
  output: jsonObjectSchema,
});

const protocolCompatibilitySchema = z.strictObject({
  minimum: z.literal(AGENT_PROTOCOL_COMPATIBILITY.minimum),
  maximum: z.literal(AGENT_PROTOCOL_COMPATIBILITY.maximum),
});
const unsupportedProtocolSchema = z.strictObject({
  reason: z.literal(AGENT_PROTOCOL_UPGRADE_GUIDANCE.reason),
  supported_protocol: protocolCompatibilitySchema,
  required_action: z.literal(AGENT_PROTOCOL_UPGRADE_GUIDANCE.required_action),
});
const schemaCatalogSchema = z.strictObject({
  agent_protocol_version: z.literal(AGENT_PROTOCOL_VERSION),
  cli_version: z.literal(CLI_VERSION),
  schema: z.literal("asana-cli.agent.schema-catalog.v2"),
  protocol_compatibility: protocolCompatibilitySchema,
  unsupported_protocol: unsupportedProtocolSchema,
  error_schema_id: z.literal(AGENT_ERROR_SCHEMA_ID),
  error_schema: jsonObjectSchema,
  actions: z.array(publishedActionSchema),
});

const singleActionSchema = z.strictObject({
  agent_protocol_version: z.literal(AGENT_PROTOCOL_VERSION),
  cli_version: z.literal(CLI_VERSION),
  schema: z.literal("asana-cli.agent.action-schema.v2"),
  protocol_compatibility: protocolCompatibilitySchema,
  unsupported_protocol: unsupportedProtocolSchema,
  error_schema_id: z.literal(AGENT_ERROR_SCHEMA_ID),
  error_schema: jsonObjectSchema,
  action: publishedActionSchema,
});

function publishAction(definition: AgentActionDefinition) {
  return publishedActionSchema.parse({
    descriptor: definition.descriptor,
    input: jsonSchemaDocument(
      definition.descriptor.input_schema,
      definition.inputSchema,
      "input",
    ),
    output: jsonSchemaDocument(
      definition.descriptor.output_schema,
      definition.outputSchema,
      "output",
    ),
  });
}

export function publishAgentSchemas(action?: string): unknown {
  if (action !== undefined) {
    return singleActionSchema.parse({
      agent_protocol_version: AGENT_PROTOCOL_VERSION,
      cli_version: CLI_VERSION,
      schema: "asana-cli.agent.action-schema.v2",
      protocol_compatibility: AGENT_PROTOCOL_COMPATIBILITY,
      unsupported_protocol: AGENT_PROTOCOL_UPGRADE_GUIDANCE,
      error_schema_id: AGENT_ERROR_SCHEMA_ID,
      error_schema: publishedAgentErrorSchema,
      action: publishAction(requireAgentAction(action)),
    });
  }
  return schemaCatalogSchema.parse({
    agent_protocol_version: AGENT_PROTOCOL_VERSION,
    cli_version: CLI_VERSION,
    schema: "asana-cli.agent.schema-catalog.v2",
    protocol_compatibility: AGENT_PROTOCOL_COMPATIBILITY,
    unsupported_protocol: AGENT_PROTOCOL_UPGRADE_GUIDANCE,
    error_schema_id: AGENT_ERROR_SCHEMA_ID,
    error_schema: publishedAgentErrorSchema,
    actions: AGENT_ACTION_NAMES.map((name) => publishAction(AGENT_ACTIONS[name])),
  });
}
