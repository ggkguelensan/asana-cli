import { z } from "zod";
import { taskMetadataProjection } from "./agent-projections";
import { AGENT_TASK_FIELDS } from "./asana-commands";
import { type GitContext } from "./git-context";
import { taskSchema, type AsanaTask } from "./schemas";
import {
  asCollection,
  collectPages,
  invokeApiMethod,
  type AsanaClient,
} from "./sdk";

export const MAX_GIT_CURRENT_CANDIDATES = 20;
const GIT_CURRENT_SOURCE_LIMIT = MAX_GIT_CURRENT_CANDIDATES + 1;

const matchFieldSchema = z.enum(["name", "notes", "custom-field"]);
const matchKindSchema = z.enum([
  "repository",
  "branch",
  "commit",
  "pull-request",
  "issue",
]);
const truncationReasonSchema = z.enum([
  "candidate-limit",
  "source-has-more",
  "git-token-limit",
]);

const resourceSchema = z.strictObject({
  gid: z.string(),
  name: z.string().optional(),
});

const taskMetadataSchema = z.strictObject({
  gid: z.string(),
  name: z.string().optional(),
  completed: z.boolean().optional(),
  completed_at: z.string().nullable().optional(),
  assignee: resourceSchema.nullable().optional(),
  due_on: z.string().nullable().optional(),
  due_at: z.string().nullable().optional(),
  start_on: z.string().nullable().optional(),
  projects: z.array(resourceSchema).optional(),
  memberships: z.array(z.strictObject({
    project: resourceSchema.nullable().optional(),
    section: resourceSchema.nullable().optional(),
  })).optional(),
  permalink_url: z.string().optional(),
  modified_at: z.string().optional(),
});

const nonTokenEvidenceSchema = z.strictObject({
  kind: z.enum(["repository", "branch", "commit"]),
  fields: z.array(matchFieldSchema).min(1).max(3),
});
const tokenEvidenceSchema = z.strictObject({
  kind: z.enum(["pull-request", "issue"]),
  number: z.number().int().positive(),
  fields: z.array(matchFieldSchema).min(1).max(3),
});
const gitMatchEvidenceSchema = z.discriminatedUnion("kind", [
  nonTokenEvidenceSchema,
  tokenEvidenceSchema,
]);

export const gitCurrentCandidatesDataSchema = z.strictObject({
  candidates: z.array(z.strictObject({
    task: taskMetadataSchema,
    matches: z.array(gitMatchEvidenceSchema).min(1).max(19),
  })).max(MAX_GIT_CURRENT_CANDIDATES),
  meta: z.strictObject({
    workspace_gid: z.string().regex(/^\d{1,64}$/),
    mine: z.boolean(),
    completed: z.boolean().optional(),
    count: z.number().int().min(0).max(MAX_GIT_CURRENT_CANDIDATES),
    max_candidates: z.literal(MAX_GIT_CURRENT_CANDIDATES),
    truncated: z.boolean(),
    truncation_reasons: z.array(truncationReasonSchema).max(3).refine(
      (reasons) => new Set(reasons).size === reasons.length,
      "truncation reasons must be unique",
    ),
  }),
});

type MatchField = z.output<typeof matchFieldSchema>;
type MatchKind = z.output<typeof matchKindSchema>;
type GitMatchEvidence = { kind: MatchKind; number?: number; fields: MatchField[] };
type TruncationReason = z.output<typeof truncationReasonSchema>;
type CandidateInput = {
  workspace_gid: string;
  all_assignees: boolean;
  completed?: boolean;
  field_gid?: string;
};
type CandidateRecord = {
  task: AsanaTask;
  evidence: Map<string, { kind: MatchKind; number?: number; fields: Set<MatchField> }>;
};
type LookupKey = {
  kind: MatchKind;
  number?: number;
  text: string;
};

const candidateTaskFields = [
  ...AGENT_TASK_FIELDS.split(","),
  "notes",
  "custom_fields",
  "custom_fields.gid",
  "custom_fields.display_value",
  "custom_fields.text_value",
].join(",");

const evidenceKindOrder: readonly MatchKind[] = [
  "repository",
  "branch",
  "commit",
  "pull-request",
  "issue",
];
const evidenceFieldOrder: readonly MatchField[] = ["name", "notes", "custom-field"];
const truncationReasonOrder: readonly TruncationReason[] = [
  "candidate-limit",
  "source-has-more",
  "git-token-limit",
];

function boundaryMatches(value: string | undefined, needle: string): boolean {
  if (value === undefined) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}($|[^A-Za-z0-9])`, "i").test(value);
}

function tokenMatches(value: string | undefined, kind: "pull-request" | "issue", number: number): boolean {
  if (value === undefined) return false;
  const prefix = kind === "pull-request" ? "(?:pr|pull)" : "(?:issue|issues)";
  const expression = kind === "pull-request"
    ? `(?:${prefix})[-_/]?${number}`
    : `(?:(?:${prefix})[-_/]?${number}|#${number})`;
  return new RegExp(`(^|[^A-Za-z0-9])${expression}($|[^A-Za-z0-9])`, "i").test(value);
}

function lookupKeys(context: GitContext): LookupKey[] {
  const keys: LookupKey[] = [{
    kind: "repository",
    text: `${context.repository.owner}/${context.repository.name}`,
  }];
  if (context.branch !== null) keys.push({ kind: "branch", text: context.branch });
  keys.push({ kind: "commit", text: context.commit });
  for (const token of context.tokens) {
    keys.push({ kind: token.kind, number: token.number, text: String(token.number) });
  }
  return keys;
}

function matchingFields(
  task: AsanaTask,
  key: LookupKey,
  fieldGid: string | undefined,
): MatchField[] {
  const matches = (value: string | undefined) => key.number === undefined
    ? boundaryMatches(value, key.text)
    : tokenMatches(value, key.kind as "pull-request" | "issue", key.number);
  const fields: MatchField[] = [];
  if (matches(task.name)) fields.push("name");
  if (matches(task.notes)) fields.push("notes");
  if (fieldGid && task.custom_fields?.some((field) =>
    field.gid === fieldGid &&
      (typeof field.display_value === "string" && matches(field.display_value) ||
        typeof field.text_value === "string" && matches(field.text_value))
  )) {
    fields.push("custom-field");
  }
  return fields;
}

function taskEvidence(
  task: AsanaTask,
  keys: readonly LookupKey[],
  fieldGid: string | undefined,
): GitMatchEvidence[] {
  const evidence = new Map<string, { kind: MatchKind; number?: number; fields: Set<MatchField> }>();
  for (const key of keys) {
    const fields = matchingFields(task, key, fieldGid);
    if (!fields.length) continue;
    const identity = `${key.kind}:${key.number ?? ""}`;
    const existing = evidence.get(identity) ?? {
      kind: key.kind,
      ...(key.number === undefined ? {} : { number: key.number }),
      fields: new Set<MatchField>(),
    };
    for (const field of fields) existing.fields.add(field);
    evidence.set(identity, existing);
  }
  return sortedEvidence(evidence);
}

function sortedEvidence(
  evidence: Map<string, { kind: MatchKind; number?: number; fields: Set<MatchField> }>,
): GitMatchEvidence[] {
  return [...evidence.values()]
    .map((entry) => ({
      kind: entry.kind,
      ...(entry.number === undefined ? {} : { number: entry.number }),
      fields: evidenceFieldOrder.filter((field) => entry.fields.has(field)),
    }))
    .sort((left, right) => {
      const kindDifference = evidenceKindOrder.indexOf(left.kind) - evidenceKindOrder.indexOf(right.kind);
      if (kindDifference !== 0) return kindDifference;
      return (left.number ?? 0) - (right.number ?? 0);
    });
}

function decimalGidCompare(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+/, "") || "0";
  const normalizedRight = right.replace(/^0+/, "") || "0";
  return normalizedLeft.length - normalizedRight.length || normalizedLeft.localeCompare(normalizedRight);
}

async function searchSource(
  client: AsanaClient,
  input: CandidateInput,
  lookup: string,
  fieldGid: string | undefined,
): Promise<{ tasks: AsanaTask[]; hasMore: boolean }> {
  const query = {
    ...(fieldGid === undefined ? { text: lookup } : { [`custom_fields.${fieldGid}.value`]: lookup }),
    opt_fields: candidateTaskFields,
    limit: GIT_CURRENT_SOURCE_LIMIT,
    ...(input.all_assignees ? {} : { "assignee.any": "me" }),
    ...(input.completed === undefined ? {} : { completed: input.completed }),
  };
  const response = await invokeApiMethod(client, "TasksApi", "searchTasksForWorkspace", [
    input.workspace_gid,
    query,
  ]);
  const collected = await collectPages(
    asCollection(response, "TasksApi.searchTasksForWorkspace"),
    false,
    GIT_CURRENT_SOURCE_LIMIT,
    taskSchema,
    "TasksApi.searchTasksForWorkspace",
  );
  return {
    tasks: collected.data,
    hasMore: collected.next_page !== null || collected.data.length === GIT_CURRENT_SOURCE_LIMIT,
  };
}

export async function findGitCurrentCandidates(
  client: AsanaClient,
  input: CandidateInput,
  context: GitContext,
): Promise<z.output<typeof gitCurrentCandidatesDataSchema>> {
  const keys = lookupKeys(context);
  const sources = new Map<string, undefined>();
  for (const key of keys) sources.set(key.text, undefined);

  const candidates = new Map<string, CandidateRecord>();
  const truncationReasons = new Set<TruncationReason>();
  if (context.tokens.length === 16) truncationReasons.add("git-token-limit");
  for (const lookup of sources.keys()) {
    for (const fieldGid of input.field_gid === undefined ? [undefined] : [undefined, input.field_gid]) {
      const source = await searchSource(client, input, lookup, fieldGid);
      if (source.hasMore) truncationReasons.add("source-has-more");
      for (const task of source.tasks) {
        const evidence = taskEvidence(task, keys, input.field_gid);
        if (!evidence.length) continue;
        const existing = candidates.get(task.gid);
        if (!existing) {
          const record: CandidateRecord = { task, evidence: new Map() };
          for (const entry of evidence) {
            record.evidence.set(`${entry.kind}:${entry.number ?? ""}`, {
              kind: entry.kind,
              ...(entry.number === undefined ? {} : { number: entry.number }),
              fields: new Set(entry.fields),
            });
          }
          candidates.set(task.gid, record);
          continue;
        }
        for (const entry of evidence) {
          const identity = `${entry.kind}:${entry.number ?? ""}`;
          const merged = existing.evidence.get(identity) ?? {
            kind: entry.kind,
            ...(entry.number === undefined ? {} : { number: entry.number }),
            fields: new Set<MatchField>(),
          };
          for (const field of entry.fields) merged.fields.add(field);
          existing.evidence.set(identity, merged);
        }
      }
    }
  }

  const ordered = [...candidates.entries()]
    .sort(([left], [right]) => decimalGidCompare(left, right));
  if (ordered.length > MAX_GIT_CURRENT_CANDIDATES) truncationReasons.add("candidate-limit");
  const output = {
    candidates: ordered.slice(0, MAX_GIT_CURRENT_CANDIDATES).map(([, candidate]) => ({
      task: taskMetadataProjection(candidate.task),
      matches: sortedEvidence(candidate.evidence),
    })),
    meta: {
      workspace_gid: input.workspace_gid,
      mine: !input.all_assignees,
      ...(input.completed === undefined ? {} : { completed: input.completed }),
      count: Math.min(ordered.length, MAX_GIT_CURRENT_CANDIDATES),
      max_candidates: MAX_GIT_CURRENT_CANDIDATES,
      truncated: truncationReasons.size > 0,
      truncation_reasons: truncationReasonOrder.filter((reason) => truncationReasons.has(reason)),
    },
  };
  return gitCurrentCandidatesDataSchema.parse(output);
}
