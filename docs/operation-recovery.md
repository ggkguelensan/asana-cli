# Operation recovery safety

The local operation journal prevents the CLI from casually starting the same prepared write twice.
It does not provide server-side exactly-once delivery, and it is not an authorization boundary
against another process running as the same OS user.

## Read-only status

A complete, non-expired operation record is an atomic snapshot. Status inspection may read that
snapshot without acquiring its mutation lock, including when a stale lock file exists. Status must
return only operation metadata needed for recovery; it must not print the task update payload,
comment text, credentials, request headers, raw HTTP bodies or error stacks.

Reading status never changes the record, removes a lock, calls Asana or chooses a recovery action.
If an expired `prepared` record still needs to be persisted as `expired`, that is a mutation and must
acquire the lock.

## Stale lock

A lock left by an interrupted process is ambiguous: the process may have stopped before or after a
local transition. Therefore:

- status inspection of an already complete, non-expired snapshot remains allowed;
- compare-and-set, apply, expiry persistence and every other mutation fail closed with `LOCKED`;
- the CLI does not infer that a lock is safe to reclaim from its age or PID;
- the CLI does not automatically remove, overwrite or retry a stale lock;
- manual file deletion is not a supported recovery procedure.

Future recovery tooling must be an explicit, separately reviewed workflow. Until it exists, preserve
the journal directory and reconcile the operation outside the mutation path.

## `applying` and `unknown`

`attempt_started_at` records when the one local apply attempt entered `applying`. It is retained in
`applied` and `unknown` records so recovery tooling can report the age of the attempt. Age is
diagnostic metadata only; it never makes an attempt safe to retry.

An `unknown` result means the remote write may have succeeded. Do not retry it automatically. Check
the task or its comments in Asana using a read-only path. If the effect cannot be reconciled, leave
the operation `unknown`; repeating a comment may create a duplicate. A new write operation is safe
only after a person or trusted external workflow has established the intended current state.

## Integrity and platform limits

`plan_hash` and `record_hash` detect accidental changes and ordinary file corruption. An
unrestricted process running as the same OS user can change a record and recompute an unkeyed hash,
so hashes are not a same-user security boundary.

On POSIX platforms the journal enforces owner checks and restrictive directory/file modes. Windows
does not implement POSIX mode bits as an equivalent ACL guarantee, and the journal's Windows ACL,
locking and rename behavior has not yet passed native end-to-end testing. Use a dedicated OS account
or stronger sandbox for hostile agents; do not treat the current Windows storage path as hardened
isolation.
