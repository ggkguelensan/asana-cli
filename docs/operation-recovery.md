# Operation recovery safety

> **CURRENT STATUS:** AP-008/AP-009 journal wiring and AP-010 local operation status are active.
> `agent apply --operation-id UUID` claims a prepared operation with compare-and-set before one
> remote write. `asana-cli agent operation status UUID` is local-only, requires no PAT or SDK
> client, and reports a safe metadata projection. Applied, applying, unknown, and expired
> operations are never dispatched again. After `unknown-result`, do not retry: a comment may
> already have been created.

The local operation journal prevents the CLI from casually starting the same prepared write twice.
It does not provide server-side exactly-once delivery or an authorization boundary against another
process running as the same OS user.

## Read-only status

`asana-cli agent operation status UUID` reads the complete atomic journal snapshot without acquiring
the mutation lock, including when a stale lock file exists. It projects only operation ID, action,
state, task GID, timestamps, result metadata, expiration status, and a diagnostic next-step
hint. It never prints a task update payload, comment text, credentials, request headers, raw HTTP
bodies, or error stacks.

Status never changes a record, removes or reclaims a lock, calls Asana, loads credentials, or chooses
a recovery action. It reports expiration from the snapshot only; persisting a prepared record as
`expired` is a mutation and remains confined to the normal locked state transition.

## Stale lock

A lock left by an interrupted process is ambiguous: the process may have stopped before or after a
local transition. Status inspection of a complete non-expired snapshot remains allowed; compare-and-
set, apply, expiry persistence, and every other mutation fail closed with `LOCKED`. The CLI never
infers that a lock is safe to reclaim from its age or PID, and it never automatically removes,
overwrites, or retries a stale lock. Manual file deletion is not a recovery procedure.

## `applying` and `unknown`

The core's `attempt_started_at` records when one local apply attempt enters `applying`. Future wiring
must retain it in `applied` and `unknown` records so status tooling can report the age of the attempt.
Age is diagnostic metadata only; it never makes an attempt safe to retry.

In the future state machine, an `unknown` result will mean the remote write may have succeeded. The
CLI must not retry it automatically. Future recovery tooling may support read-only reconciliation,
but if the effect cannot be established, the operation must remain `unknown`; repeating a comment
may create a duplicate.

Today an ambiguous `agent apply` has no safe automated recovery path even though its operation is
persisted as `unknown`. Do not retry the command. Inspect Asana separately and obtain explicit human
direction before considering a separately prepared new write.

## Integrity and platform limits

The core's `plan_hash` and `record_hash` detect accidental changes and ordinary file corruption. An
unrestricted process running as the same OS user can change a record and recompute an unkeyed hash,
so hashes are not a same-user security boundary.

The file repository enforces owner checks and restrictive directory/file modes on POSIX. Windows
does not implement POSIX mode bits as an equivalent ACL guarantee, and the journal's Windows ACL,
locking and rename behavior has not yet passed native end-to-end testing. Use a dedicated OS account
or stronger sandbox for hostile agents; do not treat the current Windows storage path as hardened
isolation.
