# Curated developer context

The authenticated agent contract exposes narrowly scoped reads for discovering exact workspace,
project, section, membership, custom-field, user, and task identifiers and for loading one compact
task working set. They are intended to remove ordinary developer workflows from the generic
`api call` and `request` surfaces.

## Commands

```sh
asana-cli agent list-projects --workspace 1200
asana-cli agent list-sections --project 1201
asana-cli agent list-project-memberships --project 1201
asana-cli agent list-project-memberships --project 1201 --member 1202
asana-cli agent list-custom-fields --workspace 1200
asana-cli agent get-custom-field --field 1203
asana-cli agent get-custom-field --field 1203 --include-values --max-content-bytes 12000
asana-cli agent resolve-user --workspace 1200 --user me
asana-cli agent resolve-task --reference gid:1204
asana-cli agent resolve-task --reference url:https://app.asana.com/1/1200/task/1204
asana-cli agent resolve-task --reference custom:1200/DEV-42
asana-cli agent resolve-task --reference task:platform/dev-013--exact-resolver
asana-cli agent context --task 1204 --max-related-results 20
asana-cli agent context --task 1204 \
  --include notes --include field-values --max-content-bytes 12000
```

Every collection requires an explicit workspace or project scope. The default page size is 50,
pagination is disabled, and the default result cap is 100. `--paginate` enables pagination, while
`--max-results` has a hard maximum of 200. Collection output reports both `has_more` and
`truncated`; neither is permission to pick an item implicitly.

`list-project-memberships` reports the current Asana membership resource for users or teams with
project access. It does not report task placement in a project.

## Custom fields

`list-custom-fields` and the default `get-custom-field` return metadata only. Enum and multi-enum
option names are external, potentially sensitive content and are excluded until
`--include-values` is supplied. Selected values share one UTF-8 budget: 16 KiB by default and
64 KiB maximum. At most 500 option records are accepted, and truncation is reported in
`content_budget`. Size bounding is not sanitization; every returned name and option value remains
untrusted.

## User resolution

`resolve-user` calls the exact workspace-scoped user endpoint with a decimal GID, `me`, or an email
address. The response contains only the supplied workspace GID and the resolved user's GID and
optional name. It never returns email, photo, workspace membership, or a user directory.

## Exact task references

`resolve-task` accepts exactly one prefixed reference:

- `gid:<decimal-gid>`;
- `url:https://app.asana.com/0/<project-or-0>/<task>[/f]`;
- `url:https://app.asana.com/1/<workspace>/[project/<project>/]task/<task>`;
- `custom:<workspace-gid>/<alphanumeric-prefix>-<positive-number>`;
- fully qualified repository alias `task:<project>/<stable-locator>--<title-slug>`.

There is no whitespace trimming, case folding, URL decoding, alternate host/scheme, query or
fragment, bare GID/URL/Custom ID, title search, Git-token inference, or fuzzy fallback. A
repository alias is read only from the fixed-root untrusted repository manifest; human local
alias/history state remains outside agent mode. The resolver revalidates the live task workspace
and project relationship. Success contains one GID. Missing, duplicate exact mappings, or changed
live scope return stable `not-found`, `ambiguous`, or `stale` errors without selecting a candidate.
The caller must explicitly pass the returned GID to a later GID-only read or prepare action.

## Compact task context

`agent context --task GID` fetches one task and bounded subtasks, dependencies, dependents, and
attachment metadata. `--max-related-results` defaults to 20 and cannot exceed 100 for each of the
four related sources. Each source reports count, `has_more`, and `truncated`.
If Asana returns `402` for a premium-only relation endpoint, only that source is marked
`premium-required`; the response is `partial` and `truncated`. Authentication, network, and
invalid-response failures still fail the complete action.

The default task projection contains structural metadata, workspace, project/section
memberships, and custom-field metadata. Notes require `--include notes`; field display values
require `--include field-values`. All selected and metadata names share one UTF-8 budget
(16 KiB default, 64 KiB maximum). Attachments expose only GID, bounded name, subtype, creation
time, and optional size. Download, permanent, and view URLs are not requested or returned, and
the CLI never opens or downloads an attachment.

## Task creation context

`prepare-task-create` requires an exact workspace GID and active project GID.
`prepare-subtask-create` requires an exact project GID and an existing parent assigned to the
authenticated user. Both actions expand the authenticated user as assignee, validate the live
project/workspace relationship, apply the fixed host scope policy, and store one immutable
approval-required operation. Subtasks additionally record the parent's exact `modified_at` as an
apply-time concurrency guard.

`prepare-task-from-template` reads only structured static defaults from the fixed repository-root
`.asana-cli/task-create-templates.json`. It resolves project/custom-field aliases through the
DEV-012 repository-context manifest, records both revisions/digests and every expanded GID, and
then follows the same direct creation checks. Templates are untrusted advisory input and never
change host policy; apply does not reread them. The complete input, policy, preview, and storage
contract is in [agent task creation](task-creation.md).

## Project and section mutation context

`prepare-task-project-add`, `prepare-task-project-remove`, and
`prepare-task-section-move` each store exactly one relation change. They require an owned task,
an exact project in the task workspace, and, when present, an exact section in that project.
Prepare and apply independently check current membership state, task `modified_at`, project scope,
and separate host-policy opt-ins. Project add never doubles as a reorder; section move is the
explicit placement action. See [agent project and section operations](task-project-operations.md).

## Dependency mutation context

`prepare-task-dependency-add` and `prepare-task-dependency-remove` each store exactly one direct
relation. The owned target and exact related task must be accessible in the same workspace.
Prepare and apply independently recheck both tasks' `modified_at` guards, current relation state,
the separate host-policy opt-in, and, for add, a bounded fail-closed cycle proof. See
[agent task dependency operations](task-dependency-operations.md).

## Bounded batch task reads

`agent batch-tasks --input -` accepts 1–10 unique exact task GIDs and selected task fields. It
constructs one fixed Asana Batch API request containing only allowlisted task GET actions. Results
stay in input order, share one UTF-8 content budget, and expose each failure as bounded metadata
without raw error bodies. See [bounded task batch reads](batch-reads.md).

## Authority and trust boundary

These actions are reads, not authorization:

- they never select a task or write target;
- project membership does not grant `prepare` or `apply`;
- returned Asana names and values are `external-untrusted`;
- fixed SDK methods and explicit projections are used; arbitrary endpoints and fields are not;
- prepare/apply still revalidate the live task, authenticated owner, membership, concurrency
  guard, and host write policy.

The endpoint semantics follow Asana's official API references for
[projects](https://developers.asana.com/reference/getprojects),
[sections](https://developers.asana.com/reference/getsectionsforproject),
[memberships](https://developers.asana.com/reference/getmemberships),
[workspace custom fields](https://developers.asana.com/reference/getcustomfieldsforworkspace),
[one custom field](https://developers.asana.com/reference/getcustomfield), and
[workspace-scoped user lookup](https://developers.asana.com/reference/getuserforworkspace).
Task-context semantics follow the official endpoints for
[one task](https://developers.asana.com/reference/gettask),
[subtasks](https://developers.asana.com/reference/getsubtasksfortask),
[dependencies](https://developers.asana.com/reference/getdependenciesfortask),
[dependents](https://developers.asana.com/reference/getdependentsfortask), and
[attachment metadata](https://developers.asana.com/reference/getattachmentsforobject).
Workspace-qualified Custom ID resolution uses the official
[Custom ID endpoint](https://developers.asana.com/reference/gettaskforcustomid); accepted v0/v1
task URL forms follow Asana's documented
[rich-text task links](https://developers.asana.com/docs/rich-text). Creation uses the official
[create task](https://developers.asana.com/reference/createtask) and
[create subtask](https://developers.asana.com/reference/createsubtaskfortask) endpoints.
Project placement follows
[add project](https://developers.asana.com/reference/addprojectfortask),
[remove project](https://developers.asana.com/reference/removeprojectfortask), and
[add task to section](https://developers.asana.com/reference/addtaskforsection).
