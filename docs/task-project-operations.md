# Agent project and section operations

Project membership and section placement use one immutable operation per change. Preparation makes
only authenticated validation reads and writes a local journal record; Asana changes only after
external approval of the exact operation ID.

## Prepare one change

All three actions accept exactly one strict JSON object on stdin:

```sh
# Add a task to a project, optionally directly into one exact section
printf '%s' '{
  "task_gid": "1200",
  "project_gid": "1201",
  "section_gid": "1202"
}' | asana-cli agent prepare-task-project-add --input -

# Remove one project membership
printf '%s' '{
  "task_gid": "1200",
  "project_gid": "1201"
}' | asana-cli agent prepare-task-project-remove --input -

# Move a task that is already in the project to another section
printf '%s' '{
  "task_gid": "1200",
  "project_gid": "1201",
  "section_gid": "1203"
}' | asana-cli agent prepare-task-section-move --input -
```

Every GID is an exact decimal Asana identifier; unknown keys and missing fields fail before an API
request. The task must be assigned to the authenticated user. The project must belong to the
task's workspace and be visible and active; a supplied section must belong to that exact project.

The actions deliberately have non-overlapping state:

- project add rejects a task already in the target project, so it cannot silently become a reorder;
- project remove rejects a task that is not in the target project;
- section move requires existing target-project membership and rejects the current section.

The prepared preview includes the task identity and exact project/optional section identity.
The durable record contains only one relation change plus the authenticated user and task
`modified_at` guards.

## Apply and recovery

After reviewing the complete preview, pass only its operation ID:

```sh
ASANA_CLI_AGENT_POLICY=read-write \
  asana-cli agent apply --operation-id 00000000-0000-4000-8000-000000000000
```

Apply refetches the task, project, and optional section; rechecks ownership, live workspace,
membership state, `modified_at`, and host policy; and claims the operation with compare-and-set
before one remote request. `applied`, `applying`, and `unknown` are never dispatched again.

An `unknown` result means the membership or section placement may already have changed. Do not
retry automatically; inspect Asana and obtain explicit human direction.

## Host policy

Project membership changes and section moves are separately disabled by default:

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
    "allow_project_membership_changes": true,
    "allow_section_moves": true
  }]
}
```

The exact changed project must appear in the matching workspace scope's `project_gids`.
`allow_project_membership_changes` controls both add and remove;
`allow_section_moves` controls only placement within a project. Repository context, aliases,
templates, argv, stdin, and environment cannot change the fixed host policy.

The endpoint behavior follows Asana's official
[add project](https://developers.asana.com/reference/addprojectfortask),
[remove project](https://developers.asana.com/reference/removeprojectfortask), and
[add task to section](https://developers.asana.com/reference/addtaskforsection) references.
