# Evidence maintenance

Files in this directory are checked-in qualification records, not logs or disposable build output.
CI validates their schemas, digests and target matrix. Archived records qualify their recorded
source, not the current workspace; new release qualification must bind the new binary explicitly.

## Contents

- `client-evals/` — behavioral decisions recorded from supported agent clients;
- `client-adapters/` — native client discovery and adapter qualification;
- `integration-lifecycle/` — install/update/uninstall behavior for every POSIX release target;
- `v1/` — immutable completion and dependency audit records for the published v1 scope.

Do not edit JSON evidence manually. Regenerate it with the corresponding `eval:*` or lifecycle
command and run the checker named next to that command in `package.json`.

## Digest dependency graph

`scripts/client-eval-contract.ts` currently computes:

```text
client subject digest
├── apps/cli/src/
├── packages/asana-client/src/
├── apps/cli/package.json + packages/asana-client/package.json
├── bun.lock
├── skills/source/
├── integrations/
└── generated/integrations/
```

The subject digest is embedded in client evaluations, adapter discovery, lifecycle evidence, and
the release evidence manifest. Therefore any source-tree change invalidates all those records by
design.

The client contract digest separately covers the behavioral evaluation schema and evaluator scripts.
The embedded integration bundle has its own digest.

## Safe refresh order

1. Complete and test source changes without hand-editing generated files.
2. Regenerate the integration bundle and client compatibility artifacts.
3. Build the exact binary to qualify.
4. Run supported client evaluations and adapter discovery.
5. Produce lifecycle evidence for every supported POSIX target.
6. Run `bun run check`, followed by `bun run check:release` for release qualification.
7. Commit source, generated outputs, and evidence together so every digest refers to one exact
   commit candidate.

Historical release evidence must never be rewritten or relabeled as evidence for a newer commit.

## Future granularity

Narrowing the subject digest may reduce unrelated evidence churn, but it changes a security gate.
Do it only in a dedicated change that defines and tests separate runtime, agent-contract,
client-adapter, and integration-lifecycle dependency sets.

## Immutable v1 archive

The v1 audit remains byte-identical and is verified against Git blobs at
`dd4760f8fc25215f9311f3eb1ea8c025137b562e`, including its original manifest and lockfile.
A full clone is required. This is historical verification, not a clean-dependency claim for today.
See [monorepo](../docs/monorepo.md) for current checks and release qualification boundaries.
