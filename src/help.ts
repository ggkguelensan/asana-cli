import { CLI_VERSION } from "./version";

export const HELP = `asana-cli ${CLI_VERSION} — Asana из терминала

USAGE
  asana-cli <command> [arguments] [options]

AUTHENTICATION
  asana-cli auth pat set [--stdin|--from-env]
  asana-cli auth pat status
  asana-cli auth pat delete
  asana-cli auth status

READ
  asana-cli me
  asana-cli workspaces [--all]
  asana-cli tasks mine [--workspace GID] [--completed false|true|all]
  asana-cli task get GID_OR_URL
  asana-cli task get-custom-id ID --workspace GID
  asana-cli task comments GID_OR_URL
  asana-cli task stories GID_OR_URL
  asana-cli task search TEXT [--workspace GID] [--all-assignees]

WRITE
  asana-cli task update GID_OR_URL --data JSON [--dry-run]
  asana-cli task update GID_OR_URL --name TEXT --completed=true [--dry-run]
  asana-cli task comment GID_OR_URL TEXT [--dry-run]
  asana-cli task comment GID_OR_URL --file PATH

SDK AND REST API
  asana-cli api list [ApiClass]
  asana-cli api docs ApiClass [method]
  asana-cli api call ApiClass method --args 'JSON array'
  asana-cli request GET|POST|PUT|PATCH|DELETE /path [--query JSON] [--data JSON]

DIAGNOSTICS AND HELP
  asana-cli doctor [--offline]
  asana-cli man [start|glossary|examples|auth]
  asana-cli --version

COMMON OPTIONS
  --fields CSV  --all  --max-results N  --compact  --help

JSON input accepts a literal value, @path, or - for stdin.
Output is JSON; diagnostics and errors use stderr.
Credentials: ASANA_ACCESS_TOKEN -> ASANA_PAT -> OS credential storage.`;

export const AUTH_HELP = `Asana PAT setup

1. Create a Personal Access Token in Asana's developer console:
   https://app.asana.com/0/my-apps

2. Recommended for a developer workstation — encrypted OS credential storage:

     asana-cli auth pat set
     asana-cli auth pat status

   The hidden prompt never puts the token in shell history. Storage uses macOS
   Keychain or Linux Secret Service.

3. Recommended for CI and ephemeral shells — process environment (higher priority).
   Use ASANA_ACCESS_TOKEN.

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
