import { z } from "zod";
import {
  applyCommentInputSchema,
  applyTaskUpdateInputSchema,
  getTaskInputSchema,
  listCommentsInputSchema,
  myTasksInputSchema,
  prepareCommentInputSchema,
  prepareTaskUpdateInputSchema,
  searchInputSchema,
  statusInputSchema,
} from "./agent-action-schemas";
import { CliError } from "./errors";
import { readAgentJsonInput } from "./io";
import { jsonObjectSchema } from "./schemas";
import { AGENT_PROTOCOL_VERSION, CLI_VERSION } from "./version";

const MAX_AGENT_INPUT_BYTES = 65_536;

const policySchema = z.enum(["read", "read-write"]);
const effectSchema = z.enum(["read", "prepare", "write"]);
const approvalClassSchema = z.enum(["none", "external-host"]);

const actionLimitsSchema = z.strictObject({
  max_input_bytes: z.number().int().min(0),
  max_result_items: z.number().int().positive().optional(),
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
});

type ActionLimits = z.input<typeof actionLimitsSchema>;
type ActionEffect = z.input<typeof effectSchema>;
type ApprovalClass = z.input<typeof approvalClassSchema>;

function actionOutputSchema<Operation extends string, Effect extends ActionEffect>(
  operation: Operation,
  effect: Effect,
) {
  return z.strictObject({
    operation: z.literal(operation),
    effect: z.literal(effect),
    policy: policySchema,
    data: z.unknown().nonoptional(),
  });
}

type DescriptorSeed = {
  operation: string;
  effect: ActionEffect;
  approval: ApprovalClass;
  limits: ActionLimits;
};

function defineAction<
  Action extends string,
  InputSchema extends z.ZodType,
>(
  action: Action,
  descriptor: DescriptorSeed,
  inputSchema: InputSchema,
) {
  const inputSchemaId = `asana-cli.agent.input.${action}.v1`;
  const outputSchemaId = `asana-cli.agent.output.${action}.v1`;
  const parsedDescriptor = agentActionDescriptorSchema.parse({
    action,
    ...descriptor,
    input_schema: inputSchemaId,
    output_schema: outputSchemaId,
    minimum_cli_version: CLI_VERSION,
  });
  return {
    descriptor: { ...parsedDescriptor, action },
    inputSchema,
    outputSchema: actionOutputSchema(
      descriptor.operation,
      descriptor.effect,
    ),
  };
}

const statusAction = defineAction(
  "status",
  {
    operation: "auth.status",
    effect: "read",
    approval: "none",
    limits: { max_input_bytes: 0 },
  },
  statusInputSchema,
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

const getTaskAction = defineAction(
  "get-task",
  {
    operation: "task.get",
    effect: "read",
    approval: "none",
    limits: { max_input_bytes: MAX_AGENT_INPUT_BYTES, max_text_chars: 8_000 },
  },
  getTaskInputSchema,
);

const listCommentsAction = defineAction(
  "list-comments",
  {
    operation: "task.comments",
    effect: "read",
    approval: "none",
    limits: { max_input_bytes: MAX_AGENT_INPUT_BYTES, max_result_items: 500 },
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
  searchInputSchema,
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
  },
  prepareTaskUpdateInputSchema,
);

const applyTaskUpdateAction = defineAction(
  "apply-task-update",
  {
    operation: "task.update.apply",
    effect: "write",
    approval: "external-host",
    limits: { max_input_bytes: MAX_AGENT_INPUT_BYTES },
  },
  applyTaskUpdateInputSchema,
);

const prepareCommentAction = defineAction(
  "prepare-comment",
  {
    operation: "task.comment.prepare",
    effect: "prepare",
    approval: "none",
    limits: { max_input_bytes: MAX_AGENT_INPUT_BYTES, max_text_chars: 8_000 },
  },
  prepareCommentInputSchema,
);

const applyCommentAction = defineAction(
  "apply-comment",
  {
    operation: "task.comment.apply",
    effect: "write",
    approval: "external-host",
    limits: { max_input_bytes: MAX_AGENT_INPUT_BYTES, max_text_chars: 8_000 },
  },
  applyCommentInputSchema,
);

export const AGENT_ACTIONS = {
  [statusAction.descriptor.action]: statusAction,
  [myTasksAction.descriptor.action]: myTasksAction,
  [getTaskAction.descriptor.action]: getTaskAction,
  [listCommentsAction.descriptor.action]: listCommentsAction,
  [searchTasksAction.descriptor.action]: searchTasksAction,
  [findGitAction.descriptor.action]: findGitAction,
  [prepareTaskUpdateAction.descriptor.action]: prepareTaskUpdateAction,
  [applyTaskUpdateAction.descriptor.action]: applyTaskUpdateAction,
  [prepareCommentAction.descriptor.action]: prepareCommentAction,
  [applyCommentAction.descriptor.action]: applyCommentAction,
};

export type AgentActionName = keyof typeof AGENT_ACTIONS;
type AgentActionDefinition = (typeof AGENT_ACTIONS)[AgentActionName];
type AgentActionInput<Action extends AgentActionName> =
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
  if (!definition) throw new CliError(`Unknown agent action: ${action}`, 2);
  return definition;
}

export function agentActionDescriptors(): z.output<typeof agentActionDescriptorSchema>[] {
  return AGENT_ACTION_NAMES.map((action) => AGENT_ACTIONS[action].descriptor);
}

export async function readAgentActionInput<Action extends AgentActionName>(
  value: string | undefined,
  action: Action,
): Promise<AgentActionInput<Action>> {
  const parsed = await readAgentJsonInput(value, AGENT_ACTIONS[action].inputSchema);
  return parsed as AgentActionInput<Action>;
}

export function createAgentActionResult(
  action: AgentActionName,
  policy: z.output<typeof policySchema>,
  data: unknown,
): unknown {
  const definition = AGENT_ACTIONS[action];
  return definition.outputSchema.parse({
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

const publishedActionSchema = z.strictObject({
  descriptor: agentActionDescriptorSchema,
  input: jsonObjectSchema,
  output: jsonObjectSchema,
});

const schemaCatalogSchema = z.strictObject({
  agent_protocol_version: z.literal(AGENT_PROTOCOL_VERSION),
  cli_version: z.literal(CLI_VERSION),
  schema: z.literal("asana-cli.agent.schema-catalog.v1"),
  actions: z.array(publishedActionSchema),
});

const singleActionSchema = z.strictObject({
  agent_protocol_version: z.literal(AGENT_PROTOCOL_VERSION),
  cli_version: z.literal(CLI_VERSION),
  schema: z.literal("asana-cli.agent.action-schema.v1"),
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
      schema: "asana-cli.agent.action-schema.v1",
      action: publishAction(requireAgentAction(action)),
    });
  }
  return schemaCatalogSchema.parse({
    agent_protocol_version: AGENT_PROTOCOL_VERSION,
    cli_version: CLI_VERSION,
    schema: "asana-cli.agent.schema-catalog.v1",
    actions: AGENT_ACTION_NAMES.map((name) => publishAction(AGENT_ACTIONS[name])),
  });
}
