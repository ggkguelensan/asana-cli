import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { z } from "zod";
import { GENERATED_CLIENT_COMPATIBILITY } from "../generated/client-compatibility";
import { parseBacklog } from "./check-project-plan";

export const V1_AUDIT_SCHEMA = "asana-cli.v1-completion-audit.v1" as const;
export const V1_DEPENDENCY_AUDIT_SCHEMA = "asana-cli.v1-dependency-audit.v1" as const;
const projectRoot = resolve(import.meta.dir, "..");
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const relativePathSchema = z.string().min(1).refine(
  (path) => !isAbsolute(path) && !path.split("/").includes("..") && !path.includes("\\"),
  "evidence paths must be project-relative POSIX paths",
);

export const v1DependencyAuditSchema = z.strictObject({
  schema: z.literal(V1_DEPENDENCY_AUDIT_SCHEMA),
  observed_on: z.iso.date(),
  tool: z.literal("bun audit"),
  tool_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  command: z.literal("bun audit --production"),
  scope: z.literal("production-dependencies"),
  advisory_source: z.literal("npm-registry"),
  lockfile: z.strictObject({
    path: z.literal("bun.lock"),
    sha256: sha256Schema,
  }),
  package_manifest: z.strictObject({
    path: z.literal("package.json"),
    sha256: sha256Schema,
  }),
  result: z.literal("no-known-vulnerabilities"),
  vulnerability_counts: z.strictObject({
    critical: z.literal(0),
    high: z.literal(0),
    moderate: z.literal(0),
    low: z.literal(0),
  }),
  ignored_advisories: z.array(z.string()).length(0),
});

const evidenceEntrySchema = z.strictObject({
  path: relativePathSchema,
  sha256: sha256Schema,
  claim: z.string().min(1),
});
const findingSchema = z.strictObject({
  id: z.string().regex(/^V1-FINDING-\d{3}$/),
  severity: z.enum(["critical", "high", "medium", "low"]),
  summary: z.string().min(1),
  disposition: z.enum(["open", "accepted", "fixed"]),
});

export const v1CompletionAuditSchema = z.strictObject({
  schema: z.literal(V1_AUDIT_SCHEMA),
  reviewed_on: z.iso.date(),
  release_state: z.literal("implementation-complete-unreleased"),
  roadmap_source: z.literal("docs/roadmap.md"),
  criteria: z.array(z.strictObject({
    id: z.enum([
      "V1-PROTOCOL-COMPATIBILITY",
      "V1-SUPPORTED-CLIENT-EVALS",
      "V1-REPRODUCIBLE-PROVENANCE",
      "V1-CURATED-WORKFLOWS",
      "V1-NO-CRITICAL-HIGH-GAPS",
      "V1-EXECUTABLE-DOCUMENTATION",
    ]),
    roadmap_criterion: z.string().min(1),
    status: z.literal("passed"),
    conclusion: z.string().min(1),
    evidence: z.array(evidenceEntrySchema).min(1),
  })).length(6),
  security_review: z.strictObject({
    outcome: z.literal("passed"),
    review_areas: z.array(z.enum([
      "credential-handling-and-redaction",
      "untrusted-content-and-output-bounds",
      "write-policy-and-operation-state-machine",
      "posix-filesystem-and-integration-lifecycle",
      "release-supply-chain",
      "production-dependencies",
    ])).length(6),
    dependency_audit: evidenceEntrySchema,
    open_findings: z.array(findingSchema),
    documented_limitations: z.array(z.strictObject({
      id: z.enum([
        "same-user-is-not-isolation",
        "ambiguous-write-needs-human-recovery",
        "experimental-clients-are-not-supported",
        "release-attestations-exist-only-after-publish",
      ]),
      reference: relativePathSchema,
    })).length(4),
  }),
  pre_v1_backlog: z.strictObject({
    total: z.number().int().positive(),
    done: z.number().int().positive(),
    cancelled: z.array(z.literal("REL-006")).length(1),
    active: z.array(z.string()).length(0),
  }),
});

export type V1CompletionAudit = z.output<typeof v1CompletionAuditSchema>;

type EvidenceSpec = Readonly<{
  path: string;
  claim: string;
}>;

const ROADMAP_CRITERIA = Object.freeze([
  {
    id: "V1-PROTOCOL-COMPATIBILITY",
    criterion: "опубликована политика protocol compatibility, migrations и deprecation",
    conclusion: "Versioned envelopes, inclusive protocol ranges, legacy migration metadata, and unsupported-client guidance are documented and covered by compatibility tests.",
    evidence: [
      { path: "docs/agent-clients.md", claim: "Published compatibility, migration, and deprecation policy." },
      { path: "src/agent-contract.ts", claim: "Runtime protocol range and deprecated-command machine contract." },
      { path: "tests/agent-protocol.test.ts", claim: "Version and protocol-range compatibility tests." },
      { path: "tests/agent-v02-compat.test.ts", claim: "Legacy client and migration compatibility tests." },
    ],
  },
  {
    id: "V1-SUPPORTED-CLIENT-EVALS",
    criterion: "поддерживаемые клиенты проходят единый набор behavioral/security evals",
    conclusion: "Every client labelled supported is qualified by a current strict behavioral/security evidence record; other native adapters remain experimental or generic.",
    evidence: [
      { path: "generated/client-compatibility.ts", claim: "Evidence-derived support classification." },
      { path: "scripts/check-client-evidence.ts", claim: "Strict freshness and scenario verifier for supported clients." },
      { path: "docs/client-evals.md", claim: "Shared twelve-scenario behavioral/security contract." },
    ],
  },
  {
    id: "V1-REPRODUCIBLE-PROVENANCE",
    criterion: "releases воспроизводимы и содержат provenance",
    conclusion: "The next release is gated on byte-identical rebuilds, per-binary SLSA and SPDX attestations, signed canonical checksums, and a linked release evidence manifest.",
    evidence: [
      { path: ".github/workflows/release.yml", claim: "Per-target reproducibility, attestations, verification, and publish gate." },
      { path: "scripts/reproducible-build.ts", claim: "Byte-identical independent rebuild verifier." },
      { path: "scripts/release-sbom.ts", claim: "Deterministic binary-linked SPDX 2.3 generator." },
      { path: "scripts/release-evidence-manifest.ts", claim: "Release-wide source, artifact, attestation, and client evidence index." },
      { path: "scripts/sigstore-bundle.ts", claim: "Exact Sigstore subject and predicate verification." },
      { path: "docs/release-verification.md", claim: "Online and offline verification procedure." },
    ],
  },
  {
    id: "V1-CURATED-WORKFLOWS",
    criterion: "critical developer workflows покрыты curated actions",
    conclusion: "Bounded developer reads and immutable prepare/apply writes are present in the agent catalog and exercised without raw API fallback.",
    evidence: [
      { path: "src/agent-contract.ts", claim: "Curated action catalog with effect, approval, schema, and bounds." },
      { path: "skills/source/asana/SKILL.md", claim: "Canonical skill restricts clients to the curated agent surface." },
      { path: "tests/agent-schema.test.ts", claim: "Runtime catalog and published schema remain aligned." },
      { path: "tests/agent-read-integration.test.ts", claim: "Bounded compiled read workflows." },
      { path: "tests/agent-operations.test.ts", claim: "Immutable prepare/apply workflow behavior." },
    ],
  },
  {
    id: "V1-NO-CRITICAL-HIGH-GAPS",
    criterion: "отсутствуют известные critical/high security gaps",
    conclusion: "The reviewed credential, untrusted-content, operation, POSIX storage, integration, supply-chain, and production dependency boundaries have no open critical or high findings.",
    evidence: [
      { path: "SECURITY.md", claim: "Threat model, guarantees, non-guarantees, and reporting policy." },
      { path: "docs/isolation-deployment.md", claim: "Same-user/container/egress boundary and deployment guidance." },
      { path: "docs/v1-completion-audit.md", claim: "Dated audit method, result, and residual limitations." },
      { path: "tests/security.test.ts", claim: "Output protection and registered-secret redaction tests." },
      { path: "tests/hostile-content.test.ts", claim: "Prompt-injection content remains untrusted data." },
      { path: "tests/wave5-security.test.ts", claim: "Scoped policy and trusted-file fail-closed tests." },
      { path: "tests/compiled-security.test.ts", claim: "Release executable security-boundary tests." },
      { path: "evidence/v1/dependency-audit.json", claim: "Dated production dependency advisory result bound to the lockfile." },
    ],
  },
  {
    id: "V1-EXECUTABLE-DOCUMENTATION",
    criterion: "документация установки, auth, permissions и восстановления после ambiguous operations полна и проверяется тестами примеров",
    conclusion: "Twelve isolated compiled-binary commands execute the documented installation, credential-source, permission-review, and ambiguous-write recovery workflows.",
    evidence: [
      { path: "docs/v1-workflows.md", claim: "Critical user-facing installation/auth/permission/recovery examples." },
      { path: "docs/operation-recovery.md", claim: "Unknown outcome and stale-lock recovery contract." },
      { path: "scripts/check-v1-examples.ts", claim: "Isolated compiled-binary executable documentation gate." },
      { path: "tests/v1-examples.test.ts", claim: "Positive execution and documentation drift tests." },
      { path: "src/help.ts", claim: "CLI grammar and auth guidance used by the examples." },
    ],
  },
] as const satisfies readonly Readonly<{
  id: V1CompletionAudit["criteria"][number]["id"];
  criterion: string;
  conclusion: string;
  evidence: readonly EvidenceSpec[];
}>[]);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function hashProjectFile(path: string): Promise<string> {
  const absolute = resolve(projectRoot, path);
  const normalizedRelative = absolute.slice(projectRoot.length + 1).split(sep).join("/");
  if (normalizedRelative !== path) {
    throw new Error(`Audit evidence path escaped or was not normalized: ${path}`);
  }
  return sha256(new Uint8Array(await Bun.file(absolute).arrayBuffer()));
}

async function materializeEvidence(specs: readonly EvidenceSpec[]) {
  return Promise.all(specs.map(async (spec) => ({
    ...spec,
    sha256: await hashProjectFile(spec.path),
  })));
}

function normalizedMarkdown(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export async function verifyV1CompletionAudit(
  auditValue: unknown,
  roadmapMarkdown: string,
  backlogMarkdown: string,
): Promise<V1CompletionAudit> {
  const audit = v1CompletionAuditSchema.parse(auditValue);
  const ids = audit.criteria.map((criterion) => criterion.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Completion audit repeats a roadmap criterion");
  }
  const roadmap = normalizedMarkdown(roadmapMarkdown);
  for (const expected of ROADMAP_CRITERIA) {
    if (!roadmap.includes(normalizedMarkdown(expected.criterion))) {
      throw new Error(`Roadmap no longer contains audited criterion ${expected.id}`);
    }
    if (!ids.includes(expected.id)) {
      throw new Error(`Completion audit omitted roadmap criterion ${expected.id}`);
    }
  }

  for (const criterion of audit.criteria) {
    for (const evidence of criterion.evidence) {
      if (await hashProjectFile(evidence.path) !== evidence.sha256) {
        throw new Error(`${criterion.id} evidence digest drifted: ${evidence.path}`);
      }
    }
  }

  const supportedEvidencePaths = Object.values(GENERATED_CLIENT_COMPATIBILITY.clients)
    .filter((client) => client.support === "supported")
    .map((client) => client.qualification.evidence)
    .filter((path) => path !== null);
  const clientCriterion = audit.criteria.find((criterion) => criterion.id === "V1-SUPPORTED-CLIENT-EVALS");
  const clientEvidencePaths = new Set(clientCriterion?.evidence.map((evidence) => evidence.path));
  for (const path of supportedEvidencePaths) {
    if (!clientEvidencePaths.has(path)) {
      throw new Error(`Supported client evidence is missing from the completion audit: ${path}`);
    }
  }

  const openSevere = audit.security_review.open_findings.filter(
    (finding) =>
      finding.disposition === "open" &&
      (finding.severity === "critical" || finding.severity === "high"),
  );
  if (openSevere.length > 0) {
    throw new Error(`Completion audit has an open ${openSevere[0]?.severity} finding: ${openSevere[0]?.id}`);
  }
  if (
    await hashProjectFile(audit.security_review.dependency_audit.path) !==
    audit.security_review.dependency_audit.sha256
  ) {
    throw new Error("Dependency audit evidence digest drifted");
  }
  const dependencyAudit = v1DependencyAuditSchema.parse(
    JSON.parse(await readFile(resolve(projectRoot, audit.security_review.dependency_audit.path), "utf8")) as unknown,
  );
  if (
    await hashProjectFile(dependencyAudit.lockfile.path) !== dependencyAudit.lockfile.sha256 ||
    await hashProjectFile(dependencyAudit.package_manifest.path) !== dependencyAudit.package_manifest.sha256
  ) {
    throw new Error("Dependency audit is stale for the current package manifest or lockfile");
  }

  const preV1 = parseBacklog(backlogMarkdown).filter((item) => item.beforeLaterBoundary);
  const active = preV1.filter((item) => item.status !== "done" && item.status !== "cancelled");
  if (active.length > 0) {
    throw new Error(`Completion audit requires all pre-1.0 work closed: ${active.map((item) => item.id).join(", ")}`);
  }
  const cancelled = preV1.filter((item) => item.status === "cancelled").map((item) => item.id);
  if (cancelled.length !== 1 || cancelled[0] !== "REL-006") {
    throw new Error("Completion audit expects only the explicit Windows cancellation REL-006");
  }
  if (
    audit.pre_v1_backlog.total !== preV1.length ||
    audit.pre_v1_backlog.done !== preV1.filter((item) => item.status === "done").length ||
    audit.pre_v1_backlog.cancelled.join(",") !== cancelled.join(",") ||
    audit.pre_v1_backlog.active.length !== 0
  ) {
    throw new Error("Completion audit backlog summary drifted");
  }
  return audit;
}

export async function buildV1CompletionAudit(): Promise<V1CompletionAudit> {
  const [roadmapMarkdown, backlogMarkdown, dependencyAuditBytes] = await Promise.all([
    readFile(resolve(projectRoot, "docs/roadmap.md"), "utf8"),
    readFile(resolve(projectRoot, "docs/backlog.md"), "utf8"),
    new Uint8Array(await Bun.file(resolve(projectRoot, "evidence/v1/dependency-audit.json")).arrayBuffer()),
  ]);
  const preV1 = parseBacklog(backlogMarkdown).filter((item) => item.beforeLaterBoundary);
  const supportedEvidence = Object.values(GENERATED_CLIENT_COMPATIBILITY.clients)
    .filter((client) => client.support === "supported")
    .map((client) => {
      const path = client.qualification.evidence;
      if (path === null) throw new Error("A supported client must have behavioral evidence");
      return {
        path,
        claim: `Passed strict behavioral/security evidence for a supported client.`,
      };
    });

  const criteria = await Promise.all(ROADMAP_CRITERIA.map(async (criterion) => ({
    id: criterion.id,
    roadmap_criterion: criterion.criterion,
    status: "passed" as const,
    conclusion: criterion.conclusion,
    evidence: await materializeEvidence(
      criterion.id === "V1-SUPPORTED-CLIENT-EVALS"
        ? [...criterion.evidence, ...supportedEvidence]
        : criterion.evidence,
    ),
  })));
  const dependencyAuditPath = "evidence/v1/dependency-audit.json";
  const audit = v1CompletionAuditSchema.parse({
    schema: V1_AUDIT_SCHEMA,
    reviewed_on: "2026-07-24",
    release_state: "implementation-complete-unreleased",
    roadmap_source: "docs/roadmap.md",
    criteria,
    security_review: {
      outcome: "passed",
      review_areas: [
        "credential-handling-and-redaction",
        "untrusted-content-and-output-bounds",
        "write-policy-and-operation-state-machine",
        "posix-filesystem-and-integration-lifecycle",
        "release-supply-chain",
        "production-dependencies",
      ],
      dependency_audit: {
        path: dependencyAuditPath,
        sha256: sha256(dependencyAuditBytes),
        claim: "Bun production-dependency audit found no known vulnerabilities on the reviewed date.",
      },
      open_findings: [],
      documented_limitations: [
        { id: "same-user-is-not-isolation", reference: "docs/isolation-deployment.md" },
        { id: "ambiguous-write-needs-human-recovery", reference: "docs/operation-recovery.md" },
        { id: "experimental-clients-are-not-supported", reference: "docs/client-compatibility.md" },
        { id: "release-attestations-exist-only-after-publish", reference: "docs/release-verification.md" },
      ],
    },
    pre_v1_backlog: {
      total: preV1.length,
      done: preV1.filter((item) => item.status === "done").length,
      cancelled: preV1.filter((item) => item.status === "cancelled").map((item) => item.id),
      active: preV1
        .filter((item) => item.status !== "done" && item.status !== "cancelled")
        .map((item) => item.id),
    },
  });
  await verifyV1CompletionAudit(audit, roadmapMarkdown, backlogMarkdown);
  return audit;
}

export function renderV1CompletionAudit(audit: V1CompletionAudit): string {
  return `${JSON.stringify(v1CompletionAuditSchema.parse(audit), null, 2)}\n`;
}
