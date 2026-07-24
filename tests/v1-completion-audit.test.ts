import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildV1CompletionAudit,
  renderV1CompletionAudit,
  verifyV1CompletionAudit,
  v1CompletionAuditSchema,
} from "../scripts/v1-completion-audit";

const projectRoot = resolve(import.meta.dir, "..");

async function currentInputs() {
  const [auditText, roadmap, backlog] = await Promise.all([
    readFile(resolve(projectRoot, "evidence/v1/completion-audit.json"), "utf8"),
    readFile(resolve(projectRoot, "docs/roadmap.md"), "utf8"),
    readFile(resolve(projectRoot, "docs/backlog.md"), "utf8"),
  ]);
  return {
    auditText,
    audit: v1CompletionAuditSchema.parse(JSON.parse(auditText) as unknown),
    roadmap,
    backlog,
  };
}

describe("v1 completion audit", () => {
  test("is byte-current and verifies every roadmap criterion against direct evidence", async () => {
    const inputs = await currentInputs();
    await verifyV1CompletionAudit(inputs.audit, inputs.roadmap, inputs.backlog);

    expect(inputs.auditText).toBe(renderV1CompletionAudit(await buildV1CompletionAudit()));
    expect(inputs.audit.criteria).toHaveLength(6);
    expect(inputs.audit.pre_v1_backlog.active).toEqual([]);
  });

  test("rejects open high findings, missing roadmap criteria, and active pre-v1 work", async () => {
    const inputs = await currentInputs();
    const severe = {
      ...inputs.audit,
      security_review: {
        ...inputs.audit.security_review,
        open_findings: [{
          id: "V1-FINDING-001",
          severity: "high",
          summary: "Test finding",
          disposition: "open",
        }],
      },
    };
    await expect(verifyV1CompletionAudit(severe, inputs.roadmap, inputs.backlog)).rejects.toThrow(
      "open high finding",
    );

    await expect(verifyV1CompletionAudit(
      inputs.audit,
      inputs.roadmap.replace(
        "поддерживаемые клиенты проходят единый набор behavioral/security evals",
        "criterion removed",
      ),
      inputs.backlog,
    )).rejects.toThrow("Roadmap no longer contains audited criterion V1-SUPPORTED-CLIENT-EVALS");

    await expect(verifyV1CompletionAudit(
      inputs.audit,
      inputs.roadmap,
      inputs.backlog.replace(
        "| V1-001 | P1 | done |",
        "| V1-001 | P1 | ready |",
      ),
    )).rejects.toThrow("all pre-1.0 work closed: V1-001");
  });
});
