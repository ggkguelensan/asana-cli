# Worktrunk and isolated agent worktrees

`asana-cli` does not create, switch, merge, or remove Git worktrees. A worktree manager such as
[Worktrunk](https://github.com/max-sixty/worktrunk) owns that lifecycle; `asana-cli` owns one
bounded mapping from the current linked worktree to an exact Asana task.

This separation keeps the integration optional and POSIX-only. It does not parse Worktrunk state,
execute `wt`, trust a branch name as a task, or make Worktrunk a runtime dependency.

## Contract

The human or a blocking lifecycle hook binds one canonical alias and immutable task GID:

```sh
asana-cli context bind task:platform/dev-017--worktree-agents \
  --task 1200000000001
```

`bind` is idempotent when the alias already has that exact GID. It fails with `conflict` when the
same alias points elsewhere; retargeting still requires the explicit revision/GID CAS command
`context alias replace`. The command then activates the alias only for the current worktree.

An agent can read only that one selection:

```sh
asana-cli agent context --worktree-task
```

The local/no-PAT/no-network response is `bound`, `unbound`, or `stale`. It contains no history,
other worktrees, raw paths, branch names, task content, or credentials. The binding is advisory:
it does not inject a GID into another action and does not authorize a write. The agent must pass
a returned bound GID explicitly to a curated read or prepare action. `unbound` and `stale` require
human intervention.

Before deleting or merging away the worktree, lifecycle automation removes its active/recent
metadata only when the expected alias is still active:

```sh
asana-cli context deactivate task:platform/dev-017--worktree-agents
```

`deactivate` is idempotent after cleanup. It refuses to clear a different active alias, preventing
a stale removal hook from erasing a newly reassigned worktree.

## Worktrunk project configuration

Merge [the example configuration](../examples/worktrunk/wt.toml) into `.config/wt.toml`.
It uses a blocking `pre-start` pipeline, so the binding is complete before `--execute` launches an
agent. The second step stores only the alias in Worktrunk's per-branch variables, which powers an
`Asana` custom column in `wt list`. A `pre-remove` hook deactivates the exact binding while the
worktree still exists. In this strict opt-in profile, removing an older unbound worktree fails on
the missing variable; inspect it and use Worktrunk's explicit `--no-hooks` only when no binding
needs cleanup.

Project hooks are repository-controlled commands. Review them and use Worktrunk's normal approval
prompt; do not bypass approval automatically.

Create an isolated task worktree and launch Codex:

```sh
wt switch -c -x codex agent/dev-017-worktree-agents \
  --asana-alias=task:platform/dev-017--worktree-agents \
  --asana-gid=1200000000001
```

Worktrunk binds `--asana-alias` and `--asana-gid` to the hook templates. If either value is absent,
template validation fails instead of starting an unbound agent. `--no-hooks` intentionally skips
the binding; the agent then observes `unbound`.

Inspect all worktrees:

```sh
wt list
```

The custom `Asana` column is operator convenience only. `asana-cli agent context --worktree-task`
remains the authoritative bounded projection for an agent running inside its current worktree.

## Plain Git compatibility

The same contract works without Worktrunk:

```sh
git worktree add -b agent/dev-017 ../repo.dev-017 main
cd ../repo.dev-017
asana-cli context bind task:platform/dev-017--worktree-agents --task 1200000000001
codex
asana-cli context deactivate task:platform/dev-017--worktree-agents
```

Bindings for linked worktrees share exact alias definitions but keep active/recent state in
separate owner-only snapshots. Removing a worktree without the cleanup hook leaves only bounded
opaque local metadata; run `deactivate` before removal to prevent a later same-name worktree from
inheriting that stale local selection.
