# Compiled-binary black-box testing

The black-box suite treats `dist/asana-cli` as the complete product boundary. Tests may interact
with the executable only through argv, stdin, stdout, stderr, exit status, an isolated POSIX
filesystem and real local Git commands. They do not import `src`, generated bundles, integration
registries, runtime schemas or test doubles.

Run it independently:

```sh
bun run test:black-box
```

That command builds the executable first. The normal `bun run check` builds once and then includes
the same tests in the complete `bun test` run. `check:black-box-boundary` rejects source imports,
execution of `src/index.ts`, loss of the standalone script or removal of the compiled process
boundary.

## Coverage matrix

| Public boundary | Black-box proof |
|---|---|
| Identity and discovery | Version/help agree; static auth help and node-asana API discovery work without credentials |
| Agent protocol | Capabilities have one protocol identity; every action published by the binary has a matching input/output JSON Schema and no false circular-reference redaction |
| Errors and policy | Human and agent wire envelopes preserve stable codes/exit statuses, reject raw URLs, credentials in argv, direct agent writes and lifecycle apply |
| Networkless human writes | Task update/comment dry-runs materialize file/stdin input and emit the exact planned request without contacting Asana |
| Repository context | Real Git identity and fixed-root `.asana-cli/repository-context.json` are projected without raw paths or remote URLs |
| Worktree isolation | Two real linked worktrees retain separate task bindings; conflict and cleanup behavior is exercised through the executable and state remains owner-only |
| Client adapters | Every embedded client is detected, inspected and planned in isolated `user` and `project` scopes |
| Managed integration lifecycle | Install/detect/status/diff/update/uninstall operates on owned files, preserves `AGENTS.md`, uses restrictive modes and denies agent-mode apply |

The suite is hermetic and deliberately does not send requests to production Asana. Authenticated
success responses, pagination and remote prepare/apply guards continue to use in-process mock HTTP
integration tests, because the production CLI intentionally has no environment-controlled API
origin. A live-token smoke suite would be non-deterministic and would weaken the fixed-origin
security boundary.
