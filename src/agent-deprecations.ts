import { z } from "zod";
import { CliError } from "./errors";

const legacyAgentApplyActionSchema = z.enum([
  "apply-task-update",
  "apply-comment",
]);

const legacyAgentApplyMigrationSchema = z.strictObject({
  reason: z.literal("legacy-plan-apply-removed"),
  replacement: z.literal("asana-cli agent apply --operation-id UUID"),
  replacement_action: z.literal("apply"),
  required_input: z.strictObject({
    operation_id: z.literal("UUID"),
  }),
});

const canonicalLegacyAgentApplyMigration = legacyAgentApplyMigrationSchema.parse({
  reason: "legacy-plan-apply-removed",
  replacement: "asana-cli agent apply --operation-id UUID",
  replacement_action: "apply",
  required_input: { operation_id: "UUID" },
});

export const deprecatedLegacyAgentApplySchema = z.strictObject({
  "apply-task-update": legacyAgentApplyMigrationSchema,
  "apply-comment": legacyAgentApplyMigrationSchema,
});

export const DEPRECATED_LEGACY_AGENT_APPLIES = deprecatedLegacyAgentApplySchema.parse({
  "apply-task-update": canonicalLegacyAgentApplyMigration,
  "apply-comment": canonicalLegacyAgentApplyMigration,
});

export type DeprecatedLegacyAgentApplyAction = z.output<typeof legacyAgentApplyActionSchema>;
export type LegacyAgentApplyMigration = z.output<typeof legacyAgentApplyMigrationSchema>;

export function deprecatedLegacyAgentApplyMigration(
  action: string | undefined,
): LegacyAgentApplyMigration | undefined {
  if (action === undefined || !Object.hasOwn(DEPRECATED_LEGACY_AGENT_APPLIES, action)) {
    return undefined;
  }
  return DEPRECATED_LEGACY_AGENT_APPLIES[action as DeprecatedLegacyAgentApplyAction];
}

export function legacyAgentApplyDeprecationManifest(): Record<string, {
  reason: "legacy-plan-apply-removed";
  replacement: "asana-cli agent apply --operation-id UUID";
  replacement_action: "apply";
  required_input: { operation_id: "UUID" };
}> {
  return Object.fromEntries(
    Object.entries(DEPRECATED_LEGACY_AGENT_APPLIES).map(([action, migration]) => [
      `asana-cli agent ${action}`,
      migration,
    ]),
  );
}

export function rejectDeprecatedLegacyAgentApply(action: string | undefined): void {
  const migration = deprecatedLegacyAgentApplyMigration(action);
  if (migration === undefined) return;
  throw new CliError(
    "usage",
    `agent ${action} was removed because complete plans are unsafe to replay`,
    undefined,
    migration,
  );
}
