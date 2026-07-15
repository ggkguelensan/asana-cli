import { z } from "zod";
import { CliError } from "./errors";

export const jsonValueSchema = z.json();
export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);
export const jsonArraySchema = z.array(jsonValueSchema);

export const gidSchema = z.string().regex(/^\d{1,64}$/, "must be a numeric Asana GID");

export const workspaceSchema = z.looseObject({
  gid: z.string(),
  name: z.string().optional(),
});

export const userSchema = z.looseObject({
  gid: z.string(),
  name: z.string().optional(),
  email: z.string().optional(),
  workspaces: z.array(workspaceSchema).optional(),
});

export const customFieldSchema = z.looseObject({
  gid: z.string().optional(),
  display_value: z.unknown().optional(),
  text_value: z.unknown().optional(),
});

export const taskSchema = z.looseObject({
  gid: z.string(),
  name: z.string().optional(),
  notes: z.string().optional(),
  html_notes: z.string().optional(),
  completed: z.boolean().optional(),
  modified_at: z.string().optional(),
  permalink_url: z.string().optional(),
  assignee: z.looseObject({
    gid: z.string().optional(),
    name: z.string().optional(),
  }).nullable().optional(),
  custom_fields: z.array(customFieldSchema).optional(),
});

export const storySchema = z.looseObject({
  gid: z.string(),
  type: z.string().optional(),
  resource_subtype: z.string().optional(),
  text: z.string().optional(),
});

export const taskListEnvelopeSchema = z.looseObject({
  data: z.array(taskSchema),
});

const dataEnvelopeSchema = z.looseObject({ data: z.unknown() });

export type JsonObject = z.infer<typeof jsonObjectSchema>;
export type AsanaTask = z.infer<typeof taskSchema>;
export type AsanaUser = z.infer<typeof userSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;

export function zodIssueSummary(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "value"}: ${issue.message}`)
    .join("; ");
}

export function parseExternalData<S extends z.ZodType>(
  value: unknown,
  schema: S,
  context: string,
): z.output<S> {
  const envelope = dataEnvelopeSchema.safeParse(value);
  if (!envelope.success) {
    throw new CliError("internal", `Unexpected response envelope from ${context}`);
  }
  const parsed = schema.safeParse(envelope.data.data);
  if (!parsed.success) {
    throw new CliError(
      "internal",
      `Invalid response data from ${context}: ${zodIssueSummary(parsed.error)}`,
    );
  }
  return parsed.data;
}
