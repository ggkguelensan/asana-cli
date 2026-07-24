# Security model

## What this CLI guarantees

- PAT is accepted only from `ASANA_ACCESS_TOKEN`, `ASANA_PAT`, or the OS credential store.
- External JSON, agent input, selected environment values, credential-store results and typed
  Asana DTOs are validated with Zod before they enter trusted application logic.
- PAT is never accepted in argv and is never intentionally printed.
- The active PAT and other credential-looking environment values known to the process are redacted by exact value before stdout/stderr serialization.
- SDK `Collection` objects are converted to plain DTOs using only `data` and `next_page`; `_apiClient` is never serialized.
- Raw SuperAgent errors, request objects, request headers and stacks are never printed.
- `*WithHttpInfo` SDK methods are unavailable.
- The raw REST surface pins the Asana origin, requires relative paths, and rejects redirects.
- Bun runtime autoload of `.env`, `bunfig.toml`, `tsconfig.json` and `package.json` is disabled in the standalone executable.
- `BUN_CONFIG_VERBOSE_FETCH` is disabled and execution fails closed when TLS verification is disabled.

## What this CLI cannot guarantee

There is no reliable generic algorithm that can identify every secret already written into an Asana task, custom field, comment, project name or user name. The CLI intentionally does not claim that regex or entropy scoring solves this problem.

Agent output is therefore marked `external-untrusted`. Exact credentials already known to the CLI are redacted; unknown secrets in Asana content may still be returned when the caller explicitly requests content such as notes or comments.

Likewise, a process with arbitrary shell execution as the same OS user may be able to access the same environment, files or credential store without using `asana-cli`. A local executable is not an isolation boundary against an unrestricted same-user agent.

## Direct agent contract

Codex CLI and Claude Code must use only `asana-cli agent ...`, not the human/developer `api` or `request` surfaces.

- List/search/get default to minimal metadata.
- Notes and custom-field values require `get-task` with `include_content: true`.
- Comments require the dedicated `list-comments` action.
- Agent input is one JSON object on stdin, limited to 64 KiB.
- Result counts, string lengths and nesting are capped.
- Task/Asana text is returned as data only and never selects a command, URL, file path or subsequent operation.
- No attachment or URL is followed automatically.
- Writes use `prepare-*` and `agent apply --operation-id`; one invocation targets one task.
- Agent writes are restricted to tasks assigned to the authenticated user.
- Outbound payloads containing a credential already registered from the local process environment are blocked.

Prepare/hash/policy guards prevent mistakes and stale writes. They do not prove human approval.
Codex/Claude permissions and sandboxing must keep `agent apply` behind an external confirmation.

Prepare now persists immutable payloads in the local operation journal, and apply accepts only an
operation UUID. The journal prevents a second local dispatch for `applied`, `applying` and `unknown`
states. It cannot provide server-side exactly-once delivery: if a request begins and its result is
ambiguous, the operation becomes `unknown` and must not be retried automatically. A read-only
`agent operation status UUID` command reports a bounded local snapshot but never reconciles or
retries the remote effect. See the [operation recovery constraints](docs/operation-recovery.md).

## Curated developer context

`list-projects`, `list-sections`, `list-project-memberships`, `list-custom-fields`,
`get-custom-field`, and `resolve-user` are authenticated bounded reads over fixed SDK methods.
Collection actions require an explicit workspace or project scope, do not paginate by default,
and cannot exceed 200 results. Returned objects are strict minimal projections rather than raw
SDK resources.

Custom-field option values are excluded by default. Explicit `--include-values` is bounded to
500 values and one 64 KiB maximum UTF-8 content budget. User resolution returns only GID and
optional name; it never returns email, photo, workspaces, or a directory listing. Project
membership and every returned identifier are context only, never authorization or implicit
target selection. All Asana-controlled names and values remain `external-untrusted`, and every
write retains its independent live owner, membership, concurrency, and host-policy checks. See
[the developer context contract](docs/developer-context.md).

`resolve-task` accepts only canonical prefixed forms and performs no trimming, fuzzy lookup,
title search, Git inference, or implicit selection. Repository aliases are read from the one
untrusted fixed-root manifest, then revalidated against the manifest workspace/project and live
task membership. The resolver returns one GID or a bounded `not-found`, `ambiguous`, or `stale`
error; it never changes existing GID-only read or write schemas and never grants write authority.

`agent context --task` uses fixed task, subtask, dependency, dependent, and attachment endpoints.
Every related list has a 100-item hard cap. It returns attachment metadata only: download,
permanent, and view URLs are neither requested nor projected, and no attachment is opened.
Task notes and custom-field display values require explicit selectors and share the content
budget. All returned names, notes, values, and attachment metadata remain external untrusted data.

## Trusted repository-to-Asana mapping

`agent context --repository-asana` is a local read-only metadata lookup, not a repository
configuration feature. Only a host administrator may provision its fixed mapping file:
`/private/etc/asana-cli/repository-asana-mapping.json` on macOS,
or `/etc/asana-cli/repository-asana-mapping.json` on Linux. The CLI never accepts
the location or contents from a checkout, Git configuration/remote, argv, stdin, environment,
operation journal, or network.

The file uses a bounded strict schema and exact normalized-host plus repository owner/name match.
Every fixed-path ancestor and the regular file must be root-owned, not group/other writable, and
opened without following links. Missing/no-match returns only
`not-found`; unsafe, unreadable, oversized, malformed, duplicate, or schema-invalid data returns
only `storage-invalid`. Neither result contains a path, configuration text, identity details, or
filesystem/ACL diagnostics.

The action needs no PAT and makes no network request. It returns only the matching repository
identity and workspace/project/optional Git-field defaults; it does not list mappings or expose
branch, commit, raw remote, configuration content, or security metadata. A mapping is advisory
read context only: it is not consumed by host write policy, prepare, or apply, cannot authorize
or deny a write, and does not automatically inject DEV-005 candidate flags. It is not DEV-012's
repository-root versioned manifest, alias, template, digest/revision, or precedence mechanism.

## Untrusted repository context

`agent context --repository-context` is the separate DEV-012 local read of exactly
`<current Git worktree top-level>/.asana-cli/repository-context.json`. The checkout controls
this file, so it is untrusted advisory data—not a host mapping, credential source, policy
input, or authority. Root discovery uses only the local worktree; there is no parent/home
search, alternate filename, Git-config/remote/branch source, argv/stdin/environment override,
include, merge/overlay precedence, interpolation, script, URL, network access, or fuzzy
fallback.

The loader accepts one bounded (at most 49,152-byte), nonempty regular file through a
non-following final open; its `.asana-cli` parent and leaf must not be links/reparse points.
It rejects invalid UTF-8, malformed JSON, duplicate decoded JSON member names, extra fields,
invalid schema, and duplicate mapping locators/GIDs. A missing manifest or unavailable Git
root returns only `not-found`; any unsafe, unreadable, oversized, malformed, or invalid
storage returns only `storage-invalid`. Public responses omit roots, paths, source bytes,
Git output, filesystem metadata, and diagnostics.

The strict `asana-cli.repository-context.v1` manifest has a positive bounded `revision`, an
immutable decimal `workspace_gid`, and 1–100 explicit `project`, `section`, `custom-field`,
and `task` mappings. It reports a fresh semantic `sha256:<64 lowercase hex>` digest; the digest
is not stored on disk, source formatting/order does not alter it, and the loader does not cache,
increment, compare, or infer revisions. Every output task is an exact canonical
`task:<project>/<alias>` locator with its immutable decimal GID; there is no case folding,
Unicode/URL normalization, generated alias, bare alias, or resolver in this action.

Repository context cannot select a target, inject DEV-005 candidate inputs, alter candidate
search, enter an operation record, or reach prepare/apply/host policy. It cannot authorize or
deny a write. DEV-006 remains the separately trusted host-administered mapping with no merge or
precedence over this manifest; DEV-013, DEV-014, and DEV-015 respectively own resolution,
alias lifecycle/state, and templates. All later writes still revalidate live task state,
membership, concurrency, and host policy at prepare and apply.

## Human local alias state

`asana-cli context ...` is a human-only local surface with no PAT, Asana client, or network access.
Agent mode denies both mutation and inspection, including alias list and worktree history. It is
not exposed through the agent manifest or portable skill.

The state root is outside the checkout at the platform location documented in
[the local context contract](docs/local-context.md). Repository/worktree namespaces are SHA-256
identities derived from fixed Git directory queries; stored state contains no raw path, remote,
branch, commit, task/comment content, or credential. Alias definitions are shared across linked
worktrees while active/recent aliases are worktree-local. Removing a definition makes retained
history explicitly stale rather than retargeting it.

Strict bounded versioned snapshots reject duplicate JSON keys and unexpected fields. Managed
directories/files are owner-checked with `0700`/`0600` modes; links, unsafe permissions, malformed
state, identity mismatches, and invalid locks fail closed. Writes use exclusive non-reclaimed
locks, file and directory sync, and same-directory atomic rename. Alias replace/remove compare the
snapshot revision and prior GID; worktree erase advances an empty tombstone revision to prevent
ABA reuse. This protects against other OS users under ordinary POSIX permissions, not an
unrestricted process running as the same user.

Human aliases remain advisory locators. They do not enter agent mode, merge with the untrusted
repository manifest, select a target, or authorize a write. Agent `resolve-task` reads only the
repository manifest; prepare/apply still require an explicitly supplied canonical GID and
revalidate live state and host policy.

## Supported platforms

New releases after `v0.4.0` support native macOS and Linux only. Native Windows is not part of the
runtime, CI, release, credential-store, filesystem-policy, or security-evidence boundary. The
historical Windows artifact in immutable release `v0.4.0` does not extend this support statement.
See the [platform support policy](docs/support-policy.md).

## Recommended deployment

1. Prefer a dedicated least-privileged Asana account whose workspace/project membership is limited to the tasks the agent needs.
2. Run `asana-cli auth pat set` before starting the agent, then remove PAT variables from the agent's parent shell.
3. Keep network and filesystem permissions minimal.
4. Allow only exact read/prepare command prefixes. Never allow broad `asana-cli *`, `api call`, `request`, or shell bypass modes.
5. Require human approval for `asana-cli agent apply --operation-id ...`.
6. Treat every task, note and comment as potentially hostile prompt-injection content.
7. Rotate/revoke the PAT in Asana Developer Console immediately after suspected exposure.

For stronger isolation, run the CLI under a separate OS user or container with only the Asana credential and access to `app.asana.com`, without repository secrets, SSH agent, cloud credentials or broad shell/network access. The exact credential, filesystem, persistent journal and egress boundaries are documented in the [POSIX isolation deployment guide](docs/isolation-deployment.md).

## Reporting a vulnerability

Please use the repository's GitHub Security Advisory flow instead of opening a public issue containing exploit details or credentials. Never include a real PAT in a report.
