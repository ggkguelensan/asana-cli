# Operation recovery safety

> **CURRENT STATUS — NOT WIRED:** The operation journal core exists, but AP-008 and AP-010 are not
> implemented. Current `agent apply-task-update` and `agent apply-comment` still accept the complete
> plan and perform a direct write. There is no `agent operation status` command, and the journal does
> not currently prevent a duplicate apply. Never retry `apply-comment` after an ambiguous failure;
> it may create a duplicate comment. This document defines required semantics for future wiring. It
> is not a recovery procedure available in the current CLI.

Once wired, the local operation journal is intended to prevent the CLI from casually starting the
same prepared write twice. It will not provide server-side exactly-once delivery, and it will not be
an authorization boundary against another process running as the same OS user.

## Read-only status

A future status implementation may read a complete, non-expired atomic snapshot without acquiring
its mutation lock, including when a stale lock file exists. It must return only operation metadata
needed for diagnosis; it must not print the task update payload, comment text, credentials, request
headers, raw HTTP bodies or error stacks.

That status operation must never change the record, remove a lock, call Asana or choose a recovery
action. If an expired `prepared` record needs to be persisted as `expired`, that is a mutation and
must acquire the lock.

## Stale lock

A lock left by an interrupted process is ambiguous: the process may have stopped before or after a
local transition. Future journal wiring must enforce these constraints:

- status inspection of an already complete, non-expired snapshot must remain allowed;
- compare-and-set, apply, expiry persistence and every other mutation must fail closed with `LOCKED`;
- wiring must not infer that a lock is safe to reclaim from its age or PID;
- tooling must not automatically remove, overwrite or retry a stale lock;
- manual file deletion must not become an implicit recovery procedure.

Recovery tooling must be an explicit, separately reviewed future workflow. The current CLI does not
provide a supported journal recovery command or manual recovery procedure.

## `applying` and `unknown`

The core's `attempt_started_at` records when one local apply attempt enters `applying`. Future wiring
must retain it in `applied` and `unknown` records so status tooling can report the age of the attempt.
Age is diagnostic metadata only; it never makes an attempt safe to retry.

In the future state machine, an `unknown` result will mean the remote write may have succeeded. The
CLI must not retry it automatically. Future recovery tooling may support read-only reconciliation,
but if the effect cannot be established, the operation must remain `unknown`; repeating a comment
may create a duplicate.

Today, because journal wiring and operation status are absent, an ambiguous `apply-comment` failure
has no safe automated recovery path. Do not retry the command. Inspect Asana separately and obtain
explicit human direction before considering any new write.

## Integrity and platform limits

The core's `plan_hash` and `record_hash` detect accidental changes and ordinary file corruption. An
unrestricted process running as the same OS user can change a record and recompute an unkeyed hash,
so hashes are not a same-user security boundary.

The file repository enforces owner checks and restrictive directory/file modes on POSIX. Windows
does not implement POSIX mode bits as an equivalent ACL guarantee, and the journal's Windows ACL,
locking and rename behavior has not yet passed native end-to-end testing. Use a dedicated OS account
or stronger sandbox for hostile agents; do not treat the current Windows storage path as hardened
isolation.
