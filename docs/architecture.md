# Architecture

`asana-cli` is a standalone Bun-compiled CLI with two public surfaces:

- human commands, which emit ordinary JSON and may request interactive confirmation;
- `asana-cli agent`, which emits a versioned, bounded, machine-readable envelope.

Both surfaces share validated domain services. The agent surface additionally enforces curated
actions, explicit read/write effects, host policy, durable prepare/apply records, and content
budgets.

## Runtime layers

```text
src/index.ts
├── cli.ts                 human command routing
├── agent-cli.ts           agent grammar and routing
├── agent-contract.ts      capabilities, action registry, JSON Schema
├── agent-operations.ts    durable prepare/apply orchestration
├── context-state.ts       alias and per-worktree context state
├── integrations/          managed client installation lifecycle
├── operations/            schemas, journal repositories, projections
└── sdk.ts / transport.ts  validated Asana boundary
```

Command routers may depend on domain services. Domain services must not depend on CLI rendering.
Filesystem repositories own persistence and locking. Zod schemas are runtime sources of truth;
generated JSON Schema and integration bundles are derived artifacts.

## State ownership

State is deliberately split by authority:

- credential manager owns the Asana PAT;
- host policy owns write authorization;
- operation journal owns immutable prepare/apply records;
- shared context state owns aliases;
- worktree context state owns the active task for one linked worktree;
- repository manifests provide advisory mappings, never write authority.

State paths must be absolute, owner-controlled POSIX locations. File-backed stores reject unsafe
permissions, symlinks, non-regular files, oversized values, stale revisions, and lock ambiguity.

## Agent write lifecycle

```text
validated input
    │
    ▼
prepare ── policy + live guards ──► immutable journal record
                                      │
                                      ▼
human approval ────────────────────► apply
                                      │
                         CAS prepared → applying
                                      │
                                      ▼
                              one remote mutation
                                      │
                         applied or terminal unknown
```

`apply` accepts only an operation ID. It never accepts a replacement payload and never
automatically retries an ambiguous remote mutation.

## Worktree isolation

Linked worktrees share repository identity and aliases but receive distinct worktree storage keys.
Worktrunk hooks bind and deactivate task context synchronously. An agent can read only the bounded
task binding for its current worktree; the binding is advisory and cannot grant write permission.

## Tests

- Unit tests validate schemas and pure domain behavior.
- Integration tests validate filesystem, subprocess, Git, and SDK boundaries.
- `tests/support/` contains reusable non-black-box fixtures.
- `tests/black-box/` executes the compiled binary without importing implementation source.
- Release tests verify package contents, POSIX targets, SBOM, provenance, reproducibility, and saved
  evidence.

Use the smallest appropriate layer. A public CLI behavior should not be considered protected solely
by a test importing `src`.

## Generated artifacts and evidence

`skills/source/` and client metadata are source inputs. `generated/integrations/` is a deterministic
embedded bundle. `evidence/` contains digest-bound qualification records and is checked in because
CI and releases verify it.

The current client subject digest includes all of:

```text
src/
skills/source/
integrations/
generated/integrations/
```

Consequently, structural changes inside `src/` require client and lifecycle evidence
requalification even when the public contract is intended to remain unchanged. See
[evidence maintenance](../evidence/README.md).

## Intended refactoring seams

Large orchestration files should be split behind their existing public exports:

- `agent-operations.ts`: prepare domains, guards, apply, and service facade;
- `context-state.ts`: schemas/projections, paths/identity, and file store;
- `integrations/lifecycle.ts`: inspection, planning, execution/rollback, and doctor.

Each split must preserve the facade, pass compiled black-box tests, and refresh digest-bound evidence
on the exact resulting commit. File length is a signal, not an architectural boundary.
