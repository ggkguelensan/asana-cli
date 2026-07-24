import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildV1CompletionAudit,
  renderV1CompletionAudit,
  verifyV1CompletionAudit,
  v1CompletionAuditSchema,
} from "./v1-completion-audit";

const projectRoot = resolve(import.meta.dir, "..");
const auditPath = resolve(projectRoot, "evidence/v1/completion-audit.json");

async function main(): Promise<void> {
  const [auditText, roadmapMarkdown, backlogMarkdown] = await Promise.all([
    readFile(auditPath, "utf8"),
    readFile(resolve(projectRoot, "docs/roadmap.md"), "utf8"),
    readFile(resolve(projectRoot, "docs/backlog.md"), "utf8"),
  ]);
  const audit = v1CompletionAuditSchema.parse(JSON.parse(auditText) as unknown);
  await verifyV1CompletionAudit(audit, roadmapMarkdown, backlogMarkdown);
  const expected = renderV1CompletionAudit(await buildV1CompletionAudit());
  if (auditText !== expected) {
    throw new Error("V1 completion audit drifted from direct repository evidence");
  }
  process.stdout.write(
    `V1 completion audit verified: ${audit.criteria.length} roadmap criteria, 0 active pre-1.0 tasks, no open critical/high findings\n`,
  );
}

if (import.meta.main) {
  await main();
}
