# v1 completion and security audit

Reviewed on 2026-07-24. Result: the planned v1 implementation is complete, all six v1 roadmap
criteria have direct digest-bound evidence, and this review found no open critical or high security
findings.

This is a code-completion result, not a claim that `v1.0.0` has already been published. The current
source version remains `0.4.0`. Release attestations, checksums, SBOMs, reproducibility records, and
`release-evidence.json` are created and verified only when an authorized maintainer selects a
version, tags an exact `main` commit, and runs the release workflow.

## Roadmap results

| Roadmap criterion | Result | Direct evidence |
|---|---|---|
| Protocol compatibility, migrations, and deprecation policy | Passed | Published agent-client contract plus protocol and v0.2 compatibility tests |
| One behavioral/security suite for every supported client | Passed | Evidence-derived compatibility matrix and current Codex/Claude eleven-scenario records |
| Reproducible releases with provenance | Passed as a release gate | Byte-identical rebuild verifier, SLSA/SPDX attestations, signed checksums, and release evidence manifest in the enforced workflow |
| Critical developer workflows use curated actions | Passed | Runtime action catalog, canonical skill, schema/read/write integration tests |
| No known critical/high security gaps | Passed | Boundary review, security suites, compiled-binary tests, and dated production dependency audit |
| Installation/auth/permissions/ambiguous recovery documentation | Passed | Twelve isolated compiled-binary commands across four executable workflows |

The authoritative machine record is
[`evidence/v1/completion-audit.json`](../evidence/v1/completion-audit.json). Its checker recomputes
every evidence digest, requires every current supported client record, matches all six roadmap
criteria, rejects an open critical/high finding, validates the dependency audit against the current
`package.json` and `bun.lock`, and refuses any active pre-1.0 backlog task:

```sh
bun run check:v1-audit
```

## Security review

The review covered:

- credential acquisition, environment inheritance, exact-value redaction, and disabled-TLS refusal;
- hostile Asana content, structural projections, byte budgets, and secret-bearing output paths;
- scoped write policy, immutable prepare/apply, atomic operation journal, and ambiguous outcomes;
- owner-only POSIX state, symlink/non-regular-file rejection, atomic integration lifecycle, and
  managed-file ownership;
- release commit/tag binding, byte-identical rebuilds, SPDX, Sigstore predicates, canonical asset
  checksums, and attestation verification;
- production dependencies locked by `bun.lock`.

The source review searched runtime code for dynamic execution, shell invocation, credential paths,
filesystem permission boundaries, and unresolved security markers. Runtime command execution is
limited to the fixed-argv, bounded-output Git context reader. No runtime `eval`, dynamic
`Function`, shell command, or arbitrary child-process surface was found.

[`bun audit`](https://bun.com/docs/pm/cli/audit) `--production` ran with Bun 1.3.14 against the
recorded lockfile on 2026-07-24 and
reported no known vulnerabilities. The dated result is saved in
[`evidence/v1/dependency-audit.json`](../evidence/v1/dependency-audit.json); a package or lockfile
change invalidates the completion audit. Because advisory databases evolve, maintainers must rerun
the dependency audit during release preparation.

## Documented limitations

These are product boundaries, not hidden security guarantees:

- an unrestricted process running as the same OS user is not isolated from credentials or local
  state; use the documented separate-user/container pattern for hostile agents;
- an `unknown` write may have succeeded remotely and requires inspection plus explicit human
  direction; it is never safe to retry automatically;
- only evidence-qualified clients are `supported`; adapter-only clients remain `experimental` and
  the portable shared format remains `generic`;
- supply-chain attestations prove a published artifact only after the release workflow has
  generated and verified them. Repository tests prove the gate, not the existence of a future
  release.

See [isolation deployment](isolation-deployment.md), [operation recovery](operation-recovery.md),
[client compatibility](client-compatibility.md), and
[release verification](release-verification.md) for the complete constraints.
