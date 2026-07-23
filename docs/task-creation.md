# Agent task creation

`asana-cli agent` creates one task or subtask through the same durable
prepare → external approval → apply boundary used by task updates and comments. Preparation makes
authenticated reads and writes one immutable local operation; it does not create an Asana task.

## Direct task and subtask preparation

The create actions accept exactly one strict JSON object on stdin:

```sh
printf '%s' '{
  "workspace_gid": "1200",
  "project_gid": "1201",
  "task": {
    "name": "Implement bounded batch reads",
    "notes": "Track DEV-011 acceptance evidence.",
    "due_on": "2026-08-15",
    "custom_fields": { "1202": "P1" }
  }
}' | asana-cli agent prepare-task-create --input -

printf '%s' '{
  "parent_task_gid": "1203",
  "project_gid": "1201",
  "task": {
    "name": "Add pagination fixture"
  }
}' | asana-cli agent prepare-subtask-create --input -
```

The direct task object supports:

- required `name` (1–500 characters);
- optional `notes` (at most 8,000 characters);
- either `due_on` (ISO date) or `due_at` (ISO timestamp with offset), never both;
- optional `start_on`, only together with a due date/time;
- at most 50 `custom_fields`, keyed by exact decimal custom-field GID.

Every object is strict: unknown keys, malformed GIDs/dates, and unsupported values fail before
preparation. Custom-field values may be a string, finite number, boolean, `null`, or an array of
strings. The authenticated current user is always expanded into the immutable `assignee_gid`;
callers cannot choose another assignee.

For a top-level task, the authenticated user must belong to the exact workspace and the project
must be active in that workspace. For a subtask, the parent must be assigned to the authenticated
user and currently belong to that exact project/workspace. The parent `modified_at` becomes a
concurrency guard.

The returned preview includes the exact workspace, project, optional parent, assignee, every task
field, operation ID, plan hash, and expiry. Apply accepts only that operation ID:

```sh
ASANA_CLI_AGENT_POLICY=read-write \
  asana-cli agent apply --operation-id 00000000-0000-4000-8000-000000000000
```

Apply refetches the current user, project, and optional parent, then rechecks ownership, live
scope, concurrency, and host policy before claiming the operation. A claimed create request is
never retried automatically. An `unknown` result may already exist in Asana and requires manual
inspection.

## Revisioned repository templates

Templates are optional repository-controlled, untrusted static defaults. The only supported file
is:

```text
<current Git worktree root>/.asana-cli/task-create-templates.json
```

It is read together with the fixed-root
`.asana-cli/repository-context.json` manifest. There is no parent search, alternate path,
environment override, include, inheritance, interpolation, script, command, URL, or network
lookup. Linked/nonregular, empty, oversized, duplicate-key, unknown-key, malformed, or unresolved
data fails closed.

Example:

```json
{
  "schema": "asana-cli.task-create-templates.v1",
  "templates": [
    {
      "alias": "feature",
      "revision": 3,
      "project_alias": "platform",
      "defaults": {
        "notes": "Complete implementation, tests, and review.",
        "due_on": "2026-08-15",
        "custom_fields": [
          { "alias": "priority", "value": "P1" }
        ]
      }
    }
  ]
}
```

`alias` and `project_alias` use the canonical lowercase repository slug grammar. Each template
alias is unique, `revision` is an explicit positive integer, and custom-field aliases are unique.
The project and custom-field aliases must resolve exactly through the current repository-context
manifest. Template defaults use only the same bounded literal task fields; a name may be supplied
by the caller instead.

Prepare a template with an exact expected revision:

```sh
printf '%s' '{
  "template": "feature",
  "template_revision": 3,
  "task": {
    "name": "Implement dependency writes"
  }
}' | asana-cli agent prepare-task-from-template --input -
```

Caller fields override scalar defaults; caller custom fields merge by exact expanded GID. The
complete merged task must still pass the direct create schema. A revision mismatch returns
`stale`; a missing alias returns `not-found`; unsafe or malformed storage returns
`storage-invalid`.

Preparation expands every alias to immutable workspace/project/custom-field GIDs and records the
template alias, explicit revision, semantic digest, repository-context revision, and
repository-context digest. Apply never rereads either repository file, so an edit after prepare
cannot change the approved operation. Repository templates remain untrusted input: inspect every
expanded target and field in the preview before approval.

## Host policy

Creation is denied by default even for an otherwise matching scope. A host-administered policy
must set `allow_task_create: true`. Create fields reuse the existing
`task_update_fields`/`custom_field_gids` allowlists, including the mandatory `name` and
`assignee` fields:

```json
{
  "schema": "asana-cli.scoped-write-policy.v1",
  "scopes": [{
    "workspace_gid": "1200",
    "project_gids": ["1201"],
    "task_update_fields": ["name", "notes", "assignee", "due_on", "custom_fields"],
    "custom_field_gids": ["1202"],
    "allow_comments": true,
    "allow_task_create": true
  }]
}
```

The policy is loaded from the fixed host path described in
[direct agent clients](agent-clients.md#host-scoped-write-policy). Repository context and
templates cannot change, extend, or replace it.

The API behavior follows Asana's official
[create task](https://developers.asana.com/reference/createtask) and
[create subtask](https://developers.asana.com/reference/createsubtaskfortask) endpoints.
