# Agent task dependency operations

Dependency changes use one immutable relation per operation. Preparation performs only
authenticated validation reads and writes a local journal record. Asana changes only after
external approval of that exact operation ID.

## Prepare one relation

Both actions accept one strict JSON object on stdin:

```sh
# Make task 1200 depend on task 1201
printf '%s' '{
  "task_gid": "1200",
  "dependency_task_gid": "1201"
}' | asana-cli agent prepare-task-dependency-add --input -

# Remove that exact direct dependency
printf '%s' '{
  "task_gid": "1200",
  "dependency_task_gid": "1201"
}' | asana-cli agent prepare-task-dependency-remove --input -
```

Both GIDs are exact decimal Asana identifiers. Unknown keys, malformed GIDs, missing fields, and
self-dependencies fail before an operation is stored. The target task must be assigned to the
authenticated user. Both tasks must be accessible in the same workspace. Add rejects an existing
direct relation; remove rejects an absent one.

The preview identifies the target and dependency. The record contains only one relation plus the
authenticated user, target `modified_at`, and dependency-task `modified_at` guards.

## Bounded cycle proof

Before dependency add, prepare traverses dependency edges starting at the proposed dependency. If
the target is reachable, the new edge would close a cycle and preparation fails with `conflict`.
The same proof runs again at apply.

The proof is deliberately bounded:

- at most 100 direct dependencies may be read from one task;
- at most 64 tasks and 16 dependency levels may be traversed;
- graph reads run with concurrency 8;
- both endpoint tasks must remain below Asana's limit of 30 dependencies and dependents combined;
- incomplete pagination, a larger graph, or an unavailable dependency endpoint fails closed with
  `ambiguous`.

The CLI never treats an incomplete traversal as evidence that an edge is safe. The Asana graph can
still change between the last validation read and the write because the API provides no atomic
graph compare-and-set. A server rejection after dispatch therefore follows the same terminal
`unknown-result` rule as every other non-idempotent operation.

## Apply and recovery

After reviewing the complete preview, apply only its operation ID:

```sh
ASANA_CLI_AGENT_POLICY=read-write \
  asana-cli agent apply --operation-id 00000000-0000-4000-8000-000000000000
```

Apply refetches both tasks, rechecks ownership, workspace, both concurrency guards, direct relation
state, host policy, and (for add) the bounded cycle proof. It claims the operation with
compare-and-set before one remote request. `applied`, `applying`, and `unknown` are never
dispatched again.

An `unknown` result means the edge may already have changed. Do not retry automatically; inspect
Asana and obtain explicit human direction.

## Host policy

Dependency changes are independently disabled by default:

```json
{
  "schema": "asana-cli.scoped-write-policy.v1",
  "scopes": [{
    "workspace_gid": "100",
    "project_gids": ["200"],
    "task_update_fields": ["name"],
    "custom_field_gids": [],
    "allow_comments": false,
    "allow_task_create": false,
    "allow_project_membership_changes": false,
    "allow_section_moves": false,
    "allow_dependency_changes": true
  }]
}
```

The owned target task must be in at least one allowed project in the matching workspace scope.
`allow_dependency_changes` controls both add and remove. Repository context, aliases, templates,
argv, stdin, and environment cannot modify the fixed host policy.

Endpoint behavior follows Asana's official
[add dependencies](https://developers.asana.com/reference/adddependenciesfortask),
[remove dependencies](https://developers.asana.com/reference/removedependenciesfortask), and
[list dependencies](https://developers.asana.com/reference/getdependenciesfortask) references.
