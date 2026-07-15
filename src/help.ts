export const VERSION = "0.1.0";

export const HELP = `asana-cli ${VERSION} — Asana API from one executable

USAGE
  asana-cli <command> [arguments] [options]

AUTHENTICATION
  asana-cli auth                         Safe PAT setup instructions
  asana-cli auth pat set                 Store PAT in the OS credential manager
  asana-cli auth pat status              Check PAT source and validity
  asana-cli auth pat delete              Delete the locally stored PAT
  asana-cli auth status                  Check whether PAT is available (never prints it)

ACCOUNT
  asana-cli me                           Current Asana user
  asana-cli workspaces [--all]           Accessible workspaces

AGENT CLIENTS (DIRECT CLI, NO MCP)
  asana-cli agent capabilities           Machine-readable safe command contract
  asana-cli agent status                 Validate auth for Codex/Claude
  asana-cli agent my-tasks --input -     Read using one JSON object from stdin
  asana-cli agent prepare-task-update --input -
  asana-cli agent apply-task-update --input -

TASKS
  asana-cli tasks mine [options]         Tasks assigned to me
  asana-cli task get <gid>               Full task information
  asana-cli task comments <gid>          Comments on a task
  asana-cli task update <gid> [options]  Update a task
  asana-cli task comment <gid> <text>    Add a comment
  asana-cli task search <text> [options] Search my tasks by text
  asana-cli task search-git <id>         Find my tasks by issue/PR/commit identifier

NODE-ASANA PRIMITIVES
  asana-cli api list [ApiClass]          List every SDK API class or method
  asana-cli api docs <ApiClass> [method] Print the official node-asana docs URL
  asana-cli api call <ApiClass> <method> --args '<JSON array>'

  Arguments use exactly the order shown in node-asana documentation:
  asana-cli api call TasksApi getTask \\
    --args '["1200123456789", {"opt_fields":"name,notes"}]'

RAW REST API
  asana-cli request <GET|POST|PUT|PATCH|DELETE> </path> \\
    [--query '<JSON object>'] [--data '<JSON value>']

COMMON OPTIONS
  --workspace <gid>      Limit a command to one workspace
  --fields <csv>         Override opt_fields
  --limit <1..100>       Page size (default: 50)
  --all                  Follow pagination
  --max-results <n>      Safety cap when following pages (default: 1000)
  --compact              Print compact JSON
  --help, -h             Show help
  --version, -V          Show version

JSON AND TEXT INPUT
  A JSON/text option accepts a literal, @file, or - for stdin:
  asana-cli task update 123 --data @update.json
  printf '{"data":{"completed":true}}' | asana-cli request PUT /tasks/123 --data -

Run 'asana-cli auth' before the first authenticated command.`;

export const AUTH_HELP = `Asana PAT setup

1. Create a Personal Access Token in Asana's developer console:
   https://app.asana.com/0/my-apps

2. Recommended for a developer workstation — encrypted OS credential storage:

     asana-cli auth pat set
     asana-cli auth pat status

   The hidden prompt never puts the token in shell history. Storage uses macOS
   Keychain, Linux Secret Service, or Windows Credential Manager.

3. Recommended for CI and ephemeral shells — process environment (higher priority).
   Use ASANA_ACCESS_TOKEN; the TOKEN suffix is recognized by agent environment filters.

   For the current shell without putting the token in shell history:
     read -s ASANA_ACCESS_TOKEN
     export ASANA_ACCESS_TOKEN

   For a CI secret:
     configure ASANA_ACCESS_TOKEN in your CI secret store and expose it only to the job.

4. Verify without revealing the token:
     asana-cli auth status
     asana-cli me

Compatibility alias: ASANA_PAT.

Security notes:
  - Never commit PATs or .env files.
  - Never pass a PAT as a command-line argument; process arguments may be visible.
  - Rotate the PAT immediately if it is exposed.
  - asana-cli never prints the token and intentionally does not load .env files.

Creating, reviewing, resetting, and revoking PATs is done in Asana's developer
console. 'auth pat' manages only this machine's encrypted local copy.`;

export const PAT_HELP = `Manage this machine's Asana PAT

  asana-cli auth pat set                 Hidden interactive prompt
  printf '%s' "$ASANA_ACCESS_TOKEN" | asana-cli auth pat set --stdin
  asana-cli auth pat set --from-env      Copy env PAT into OS credential storage
  asana-cli auth pat status              Validate the active PAT without printing it
  asana-cli auth pat delete              Delete only the OS-stored PAT

Credential precedence:
  ASANA_ACCESS_TOKEN -> ASANA_PAT -> OS credential storage

PAT creation and revocation remain in Asana Developer Console:
  https://app.asana.com/0/my-apps`;
