# Human alias and worktree context

`asana-cli context ...` is the human-only, local DEV-014/DEV-017 surface. It keeps exact task aliases and
the current worktree selection without reading a PAT, constructing an Asana client, or making a
network request. It is separate from `asana-cli agent context ...`; agent mode rejects every
human command in this surface, including bind, deactivate, alias listing and history. The distinct
`asana-cli agent context --worktree-task` action reads only one bounded projection of the current
worktree binding.

## Command contract

Aliases always use the fully qualified canonical
`task:<project-alias>/<stable-locator>--<title-slug>` form and point to an immutable decimal Asana
task GID.

```sh
# Create and inspect a repository-local alias definition
asana-cli context alias set task:platform/dev-014--local-context --task 1200000000001
asana-cli context alias list

# Retarget only after comparing both the store revision and old immutable GID
asana-cli context alias replace task:platform/dev-014--local-context \
  --task 1200000000002 \
  --expected-task 1200000000001 \
  --revision 1

# Select one alias for this worktree and inspect local context
asana-cli context activate task:platform/dev-014--local-context
asana-cli context quick
asana-cli context history

# Idempotent lifecycle binding for a worktree manager
asana-cli context bind task:platform/dev-017--worktree-agents --task 1200000000003
asana-cli context deactivate task:platform/dev-017--worktree-agents

# Remove a definition with compare-and-set
asana-cli context alias remove task:platform/dev-014--local-context \
  --expected-task 1200000000002 \
  --revision 2

# Erase active/recent aliases for this worktree using its current revision
asana-cli context clear --revision 1
```

Every command accepts only the positionals and flags shown above, plus optional `--compact`.
Malformed grammar, aliases, GIDs, repeated flags, and missing CAS inputs fail before Git identity
or state is read. `set` refuses an existing alias. `replace` and `remove` require both the current
alias-store `revision` from `alias list` and the current `--expected-task` GID. A mismatch returns
`stale`; callers must inspect again and make a new explicit decision.

`activate` requires an existing local alias. `quick` returns the active alias only; `history`
also returns at most 20 most-recent unique aliases. Removing an active/recent alias definition does
not silently rewrite worktree history: it is projected as `status: "stale"` until the user
activates another alias or clears the worktree state. `clear` uses the `worktree_revision` returned
by `quick` or `history`, removes active/recent values, and advances a metadata-only tombstone
revision so an old revision cannot match after erase-and-recreate.

These commands manage locators, not cached Asana task cards. They do not verify that a GID exists
or fetch task content. The separate DEV-013 exact resolver reads repository-manifest aliases, not
this human local store; local aliases never enter agent mode, select, or authorize an agent write.

`bind` is the lifecycle-safe composition used by worktree managers. Under the repository alias
lock it creates a missing alias or accepts an existing exact alias/GID pair; a different GID is a
`conflict` and still requires explicit CAS `replace`. It then idempotently activates the alias for
only the current worktree. If activation is interrupted after a new alias was stored, retrying the
same bind safely completes the operation.

`deactivate QUALIFIED_ALIAS` clears active/recent metadata only when that exact alias is active.
It is idempotent when the worktree is already unbound and returns `conflict` rather than clearing
a different active assignment. This makes it suitable for a blocking worktree `pre-remove` hook.

The agent projection is:

```sh
asana-cli agent context --worktree-task
```

Its strict `asana-cli.worktree-task.v1` data has `worktree_revision` and a task state:
`bound` with exact alias/GID, `unbound`, or `stale` with the removed alias and no GID. It never
returns history, raw storage identity, paths, branches, remotes, task content, or credentials.
The result is advisory and never modifies another action, selects a write target implicitly, or
expands host policy.

## Worktree and repository scope

The CLI asks Git for only its absolute common directory and current worktree Git directory, then
immediately hashes each with SHA-256 and a distinct domain separator. Raw paths, repository
remotes, branches, commits, task/comment text, and credentials are neither returned nor stored.

- `repository_key` is derived from Git's common directory, so aliases are shared by the primary
  checkout and its linked worktrees.
- `worktree_key` is derived from the current worktree Git directory, so active/recent state is
  isolated per linked worktree.

Moving or recreating a repository changes its filesystem identity and therefore starts a new local
context namespace. No remote URL is used as a fallback. Repository-controlled
`.asana-cli/repository-context.json` aliases remain a distinct untrusted manifest source; DEV-014
does not merge it with the human alias store or define precedence.

Recreating a linked worktree with the same Git worktree metadata path can reuse its opaque key.
Use the documented `deactivate`/Worktrunk `pre-remove` hook before deletion so a later same-name
worktree cannot inherit an old active selection.

## Storage and limits

State is outside the checkout:

- macOS: `$HOME/Library/Application Support/asana-cli/context`;
- Linux: `${XDG_STATE_HOME:-$HOME/.local/state}/asana-cli/context`.

Only opaque hash segments appear below that root. Alias snapshots use a strict
`asana-cli.shared-aliases.v1` schema and contain at most 100 exact alias/GID pairs. Worktree
snapshots use `asana-cli.worktree-context.v1` and contain one optional active alias plus at most
20 recent aliases. JSON is bounded to 64 KiB, rejects duplicate decoded keys and unknown fields,
and uses positive revisions capped at `2147483647`.

Managed directories are owner-checked and mode `0700`; files and locks are owner-checked and mode
`0600`. Reads reject links, non-regular files, insecure permissions, invalid identity keys,
empty/oversized/malformed JSON, and schema mismatches with generic `storage-invalid`. Mutations use
exclusive locks, same-directory temporary files, file `fsync`, atomic rename, and directory
`fsync`. A process running with unrestricted access as the same OS user is still outside this
filesystem boundary.

## Interrupted mutation recovery

Reads use complete atomic snapshots and do not acquire a mutation lock. A lock left by an
interrupted process blocks later mutations with retryable `storage-locked`; the CLI never guesses
that a lock is stale from its PID or age and never removes it automatically. Invalid or insecure
lock files return `storage-invalid`.

Because this state has no remote side effect, an administrator can recover after confirming that
no `asana-cli context` mutation is still running: inspect `alias list`/`history`, preserve a backup
of the state root if needed, and remove only the matching `.lock` file. Do not delete the whole
state root as a generic recovery step. Then rerun the intended command with the current revision
and expected GID.
