import { z } from "zod";

export const INTEGRATION_SKILLS = [
  {
    id: "asana",
    display_name: "Asana CLI",
    description: "Safe, practical use of asana-cli for reading and changing Asana.",
  },
  {
    id: "asana-concepts",
    display_name: "Asana concepts",
    description: "Asana's object model, vocabulary, permissions, and common workflows.",
  },
  {
    id: "asana-company-discovery",
    display_name: "Company Asana discovery",
    description: "A bounded, read-only method for learning how one company organizes Asana.",
  },
  {
    id: "asana-cli-insights",
    display_name: "Asana CLI insights",
    description: "Analyze metadata-only local CLI history and suggest workflow improvements.",
  },
] as const;

export const INTEGRATION_SKILL_IDS = INTEGRATION_SKILLS.map(
  (skill) => skill.id,
) as [
  (typeof INTEGRATION_SKILLS)[number]["id"],
  ...(typeof INTEGRATION_SKILLS)[number]["id"][],
];

export const integrationSkillIdSchema = z.enum(INTEGRATION_SKILL_IDS);
export type IntegrationSkillId = z.output<typeof integrationSkillIdSchema>;

export function integrationSkill(id: IntegrationSkillId) {
  const skill = INTEGRATION_SKILLS.find((candidate) => candidate.id === id);
  if (!skill) throw new Error(`Unknown embedded integration skill: ${id}`);
  return skill;
}
