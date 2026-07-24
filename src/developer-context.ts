import { z } from "zod";
import { ContentBudget } from "./content-budget";
import { CliError } from "./errors";
import {
  asCollection,
  collectPages,
  invokeApiMethod,
  type AsanaClient,
} from "./sdk";
import { gidSchema } from "./schemas";

export const MAX_CONTEXT_RESULTS = 200;
export const MAX_CUSTOM_FIELD_VALUES = 500;

const boundedNameSchema = z.string().max(10_000);
const resourceTypeSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/);
const customFieldSubtypeSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/);

const externalResourceSchema = z.looseObject({
  gid: gidSchema,
  name: boundedNameSchema.optional(),
  resource_type: resourceTypeSchema.optional(),
});

const compactResourceSchema = z.strictObject({
  gid: gidSchema,
  name: boundedNameSchema.optional(),
  resource_type: resourceTypeSchema.optional(),
});

const externalProjectSchema = z.looseObject({
  gid: gidSchema,
  name: boundedNameSchema.optional(),
  archived: z.boolean().optional(),
  workspace: externalResourceSchema.optional(),
});

export const projectContextSchema = z.strictObject({
  gid: gidSchema,
  name: boundedNameSchema.optional(),
  archived: z.boolean().optional(),
});

const externalSectionSchema = z.looseObject({
  gid: gidSchema,
  name: boundedNameSchema.optional(),
  project: externalResourceSchema.optional(),
});

export const sectionContextSchema = z.strictObject({
  gid: gidSchema,
  name: boundedNameSchema.optional(),
});

const membershipAccessLevelSchema = z.enum([
  "admin",
  "editor",
  "commenter",
  "viewer",
]);

const externalMembershipSchema = z.looseObject({
  gid: gidSchema,
  resource_subtype: z.literal("project_membership").optional(),
  parent: externalResourceSchema,
  member: externalResourceSchema,
  access_level: membershipAccessLevelSchema.optional(),
});

export const projectMembershipContextSchema = z.strictObject({
  gid: gidSchema,
  member: compactResourceSchema,
  access_level: membershipAccessLevelSchema.optional(),
});

const externalEnumOptionSchema = z.looseObject({
  gid: gidSchema,
  name: boundedNameSchema.optional(),
  enabled: z.boolean().optional(),
  color: z.string().max(64).optional(),
});

export const customFieldEnumOptionContextSchema = z.strictObject({
  gid: gidSchema,
  name: boundedNameSchema.optional(),
  enabled: z.boolean().optional(),
  color: z.string().max(64).optional(),
});

const externalCustomFieldMetadataSchema = z.looseObject({
  gid: gidSchema,
  name: boundedNameSchema.optional(),
  resource_subtype: customFieldSubtypeSchema.optional(),
  representation_type: customFieldSubtypeSchema.optional(),
  id_prefix: z.string().max(64).optional(),
  is_global_to_workspace: z.boolean().optional(),
});

const externalSelectedCustomFieldSchema = externalCustomFieldMetadataSchema.extend({
  enum_options: z.array(externalEnumOptionSchema).max(MAX_CUSTOM_FIELD_VALUES).optional(),
});

export const customFieldMetadataSchema = z.strictObject({
  gid: gidSchema,
  name: boundedNameSchema.optional(),
  resource_subtype: customFieldSubtypeSchema.optional(),
  representation_type: customFieldSubtypeSchema.optional(),
  id_prefix: z.string().max(64).optional(),
  is_global_to_workspace: z.boolean().optional(),
});

export const selectedCustomFieldMetadataSchema = customFieldMetadataSchema.extend({
  enum_options: z.array(customFieldEnumOptionContextSchema)
    .max(MAX_CUSTOM_FIELD_VALUES)
    .optional(),
});

const externalResolvedUserSchema = z.looseObject({
  gid: gidSchema,
  name: boundedNameSchema.optional(),
  resource_type: z.literal("user").optional(),
});

export const resolvedUserContextSchema = z.strictObject({
  gid: gidSchema,
  name: boundedNameSchema.optional(),
});

const collectionMetaFields = {
  count: z.number().int().nonnegative().max(MAX_CONTEXT_RESULTS),
  max_results: z.number().int().min(1).max(MAX_CONTEXT_RESULTS),
  truncated: z.boolean(),
  has_more: z.boolean(),
};

export const projectListContextDataSchema = z.strictObject({
  data: z.array(projectContextSchema).max(MAX_CONTEXT_RESULTS),
  meta: z.strictObject({
    ...collectionMetaFields,
    workspace_gid: gidSchema,
    archived: z.boolean(),
  }),
});

export const sectionListContextDataSchema = z.strictObject({
  data: z.array(sectionContextSchema).max(MAX_CONTEXT_RESULTS),
  meta: z.strictObject({
    ...collectionMetaFields,
    project_gid: gidSchema,
  }),
});

export const projectMembershipListContextDataSchema = z.strictObject({
  data: z.array(projectMembershipContextSchema).max(MAX_CONTEXT_RESULTS),
  meta: z.strictObject({
    ...collectionMetaFields,
    project_gid: gidSchema,
    member_gid: gidSchema.optional(),
  }),
});

export const customFieldListContextDataSchema = z.strictObject({
  data: z.array(customFieldMetadataSchema).max(MAX_CONTEXT_RESULTS),
  meta: z.strictObject({
    ...collectionMetaFields,
    workspace_gid: gidSchema,
    values_included: z.literal(false),
  }),
});

const contentBudgetMetadataSchema = z.strictObject({
  max_bytes: z.number().int().nonnegative(),
  emitted_bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  truncated_values: z.number().int().nonnegative(),
  truncated_paths: z.array(z.string()),
});

export const customFieldContextDataSchema = z.strictObject({
  custom_field: selectedCustomFieldMetadataSchema,
  values_profile: z.enum(["metadata", "selected-untrusted"]),
  content_budget: contentBudgetMetadataSchema,
});

export const resolvedUserContextDataSchema = z.strictObject({
  workspace_gid: gidSchema,
  user: resolvedUserContextSchema,
});

type PageInput = Readonly<{
  limit: number;
  paginate: boolean;
  max_results: number;
}>;

type CollectionResult<Item> = Readonly<{
  data: Item[];
  meta: Readonly<{
    count: number;
    max_results: number;
    truncated: boolean;
    has_more: boolean;
  }>;
}>;

function compactObject(entries: Array<[string, unknown]>): Record<string, unknown> {
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
}

async function boundedCollection<Item>(
  client: AsanaClient,
  apiClass: string,
  method: string,
  args: unknown[],
  input: PageInput,
  itemSchema: z.ZodType<Item>,
): Promise<CollectionResult<Item>> {
  const context = `${apiClass}.${method}`;
  const result = await invokeApiMethod(client, apiClass, method, args);
  const collected = await collectPages(
    asCollection(result, context),
    input.paginate,
    input.max_results,
    itemSchema,
    context,
    true,
  );
  const hasMore = collected.next_page !== null && collected.next_page !== undefined;
  return {
    data: collected.data,
    meta: {
      count: collected.data.length,
      max_results: input.max_results,
      truncated: collected.truncated ?? false,
      has_more: hasMore,
    },
  };
}

function assertScopedResource(
  actual: z.output<typeof externalResourceSchema> | undefined,
  expectedGid: string,
  context: string,
): void {
  if (actual !== undefined && actual.gid !== expectedGid) {
    throw new CliError("internal", `Invalid scoped response from ${context}`);
  }
}

export async function listProjectsContext(
  client: AsanaClient,
  input: PageInput & Readonly<{ workspace_gid: string; archived: boolean }>,
): Promise<z.output<typeof projectListContextDataSchema>> {
  const collection = await boundedCollection(
    client,
    "ProjectsApi",
    "getProjects",
    [{
      workspace: input.workspace_gid,
      archived: input.archived,
      limit: Math.min(input.limit, input.max_results),
      opt_fields: "gid,name,archived,workspace.gid",
    }],
    input,
    externalProjectSchema,
  );
  const data = collection.data.map((project) => {
    assertScopedResource(project.workspace, input.workspace_gid, "ProjectsApi.getProjects");
    return projectContextSchema.parse(compactObject([
      ["gid", project.gid],
      ["name", project.name],
      ["archived", project.archived],
    ]));
  });
  return projectListContextDataSchema.parse({
    data,
    meta: {
      ...collection.meta,
      workspace_gid: input.workspace_gid,
      archived: input.archived,
    },
  });
}

export async function listSectionsContext(
  client: AsanaClient,
  input: PageInput & Readonly<{ project_gid: string }>,
): Promise<z.output<typeof sectionListContextDataSchema>> {
  const collection = await boundedCollection(
    client,
    "SectionsApi",
    "getSectionsForProject",
    [
      input.project_gid,
      {
        limit: Math.min(input.limit, input.max_results),
        opt_fields: "gid,name,project.gid",
      },
    ],
    input,
    externalSectionSchema,
  );
  const data = collection.data.map((section) => {
    assertScopedResource(section.project, input.project_gid, "SectionsApi.getSectionsForProject");
    return sectionContextSchema.parse(compactObject([
      ["gid", section.gid],
      ["name", section.name],
    ]));
  });
  return sectionListContextDataSchema.parse({
    data,
    meta: { ...collection.meta, project_gid: input.project_gid },
  });
}

export async function listProjectMembershipsContext(
  client: AsanaClient,
  input: PageInput & Readonly<{ project_gid: string; member_gid?: string }>,
): Promise<z.output<typeof projectMembershipListContextDataSchema>> {
  const collection = await boundedCollection(
    client,
    "MembershipsApi",
    "getMemberships",
    [{
      parent: input.project_gid,
      resource_subtype: "project_membership",
      ...(input.member_gid === undefined ? {} : { member: input.member_gid }),
      limit: Math.min(input.limit, input.max_results),
      opt_fields: [
        "gid",
        "resource_subtype",
        "parent.gid",
        "member.gid",
        "member.name",
        "member.resource_type",
        "access_level",
      ].join(","),
    }],
    input,
    externalMembershipSchema,
  );
  const data = collection.data.map((membership) => {
    assertScopedResource(membership.parent, input.project_gid, "MembershipsApi.getMemberships");
    if (input.member_gid !== undefined && membership.member.gid !== input.member_gid) {
      throw new CliError("internal", "Invalid scoped response from MembershipsApi.getMemberships");
    }
    return projectMembershipContextSchema.parse(compactObject([
      ["gid", membership.gid],
      ["member", compactObject([
        ["gid", membership.member.gid],
        ["name", membership.member.name],
        ["resource_type", membership.member.resource_type],
      ])],
      ["access_level", membership.access_level],
    ]));
  });
  return projectMembershipListContextDataSchema.parse({
    data,
    meta: {
      ...collection.meta,
      project_gid: input.project_gid,
      ...(input.member_gid === undefined ? {} : { member_gid: input.member_gid }),
    },
  });
}

export async function listCustomFieldsContext(
  client: AsanaClient,
  input: PageInput & Readonly<{ workspace_gid: string }>,
): Promise<z.output<typeof customFieldListContextDataSchema>> {
  const collection = await boundedCollection(
    client,
    "CustomFieldsApi",
    "getCustomFieldsForWorkspace",
    [
      input.workspace_gid,
      {
        limit: Math.min(input.limit, input.max_results),
        opt_fields: [
          "gid",
          "name",
          "resource_subtype",
          "representation_type",
          "id_prefix",
          "is_global_to_workspace",
        ].join(","),
      },
    ],
    input,
    externalCustomFieldMetadataSchema,
  );
  const data = collection.data.map(customFieldMetadata);
  return customFieldListContextDataSchema.parse({
    data,
    meta: {
      ...collection.meta,
      workspace_gid: input.workspace_gid,
      values_included: false,
    },
  });
}

function customFieldMetadata(
  field: z.output<typeof externalCustomFieldMetadataSchema>,
): z.output<typeof customFieldMetadataSchema> {
  return customFieldMetadataSchema.parse(compactObject([
    ["gid", field.gid],
    ["name", field.name],
    ["resource_subtype", field.resource_subtype],
    ["representation_type", field.representation_type],
    ["id_prefix", field.id_prefix],
    ["is_global_to_workspace", field.is_global_to_workspace],
  ]));
}

export async function getCustomFieldContext(
  client: AsanaClient,
  input: Readonly<{
    field_gid: string;
    include_values: boolean;
    max_content_bytes?: number;
  }>,
): Promise<z.output<typeof customFieldContextDataSchema>> {
  const selectedFields = [
    "gid",
    "name",
    "resource_subtype",
    "representation_type",
    "id_prefix",
    "is_global_to_workspace",
    ...(input.include_values
      ? [
        "enum_options",
        "enum_options.gid",
        "enum_options.name",
        "enum_options.enabled",
        "enum_options.color",
      ]
      : []),
  ];
  const value = await invokeApiMethod(
    client,
    "CustomFieldsApi",
    "getCustomField",
    [input.field_gid, { opt_fields: selectedFields.join(",") }],
  );
  const envelope = z.looseObject({ data: z.unknown() }).safeParse(value);
  if (!envelope.success) {
    throw new CliError("internal", "Invalid response data from CustomFieldsApi.getCustomField");
  }
  const selectedField = input.include_values
    ? externalSelectedCustomFieldSchema.safeParse(envelope.data.data)
    : externalCustomFieldMetadataSchema.safeParse(envelope.data.data);
  if (!selectedField.success || selectedField.data.gid !== input.field_gid) {
    throw new CliError("internal", "Invalid response data from CustomFieldsApi.getCustomField");
  }
  const field = selectedField.data;
  const budget = new ContentBudget(input.max_content_bytes ?? 16_384);
  const parsedOptions = input.include_values
    ? externalSelectedCustomFieldSchema.parse(field).enum_options
    : undefined;
  const enumOptions = parsedOptions === undefined
    ? undefined
    : parsedOptions.map((option, index) =>
      customFieldEnumOptionContextSchema.parse(compactObject([
        ["gid", option.gid],
        [
          "name",
          option.name === undefined
            ? undefined
            : budget.take(option.name, `custom_field.enum_options[${index}].name`),
        ],
        ["enabled", option.enabled],
        ["color", option.color],
      ]))
    );
  return customFieldContextDataSchema.parse({
    custom_field: {
      ...customFieldMetadata(field),
      ...(enumOptions === undefined ? {} : { enum_options: enumOptions }),
    },
    values_profile: input.include_values ? "selected-untrusted" : "metadata",
    content_budget: budget.metadata(),
  });
}

export async function resolveUserContext(
  client: AsanaClient,
  input: Readonly<{ workspace_gid: string; user: string }>,
): Promise<z.output<typeof resolvedUserContextDataSchema>> {
  const value = await invokeApiMethod(
    client,
    "UsersApi",
    "getUserForWorkspace",
    [
      input.workspace_gid,
      input.user,
      { opt_fields: "gid,name,resource_type" },
    ],
  );
  const envelope = z.looseObject({ data: externalResolvedUserSchema }).safeParse(value);
  if (!envelope.success) {
    throw new CliError("internal", "Invalid response data from UsersApi.getUserForWorkspace");
  }
  return resolvedUserContextDataSchema.parse({
    workspace_gid: input.workspace_gid,
    user: compactObject([
      ["gid", envelope.data.data.gid],
      ["name", envelope.data.data.name],
    ]),
  });
}
