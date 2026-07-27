# Contributing

`asana-cli` maintains a security-sensitive CLI contract for people and coding agents. Keep changes
small, preserve the public wire format unless the protocol is intentionally versioned, and leave the
branch in a releasable state.

## Local setup

Requirements:

- macOS or Linux;
- Bun version from `packageManager` in `package.json`;
- Git.

```sh
bun install --frozen-lockfile
bun run check:fast
```

The project intentionally does not support Windows runtime or release artifacts. See
[the support policy](docs/support-policy.md).

## Change workflow

1. Branch from the latest `origin/main`. A dedicated Git worktree is recommended for every agent or
   concurrent task.
2. Add or update tests at the narrowest useful layer.
3. Run `bun run check:fast` during development.
4. Run `bun run check` before requesting review.
5. Use `bun run check:release` only when qualifying the current compiled artifact for release.

Use `bun run clean` to remove local `dist/` artifacts. The command validates the exact distribution
path before deleting it.

## Test boundaries

- Unit and integration tests may use helpers from `tests/support/`.
- Tests under `tests/black-box/` must remain source-isolated and execute only `dist/asana-cli`.
- Never put real PATs, Asana task content, local credential-store data, or production paths in
  fixtures and snapshots.
- A behavior visible through argv, stdin, stdout, stderr, exit status, filesystem state, or Git
  worktrees should have black-box coverage.

The complete boundary is documented in [black-box testing](docs/black-box-testing.md).

## Generated files and evidence

Do not edit `generated/` or machine evidence by hand. Run the corresponding generator or evaluation
command and commit the source plus its deterministic output together.

Any change below `src/`, `skills/source/`, `integrations/`, or `generated/integrations/` changes the
current client-evaluation subject digest. Read [evidence maintenance](evidence/README.md) before
refactoring those trees.

## Pull requests

- Keep refactoring separate from behavior changes.
- Explain affected trust boundaries and compatibility contracts.
- Include the commands used for verification.
- Do not combine a version bump, evidence refresh, and unrelated cleanup.
- Do not modify user-owned `AGENTS.md`, `CLAUDE.md`, client settings, hooks, or credentials.

The architecture and module boundaries are described in [docs/architecture.md](docs/architecture.md).
