# Critical v1 workflows

These examples are kept executable against the compiled macOS/Linux binary. They use only POSIX
shell conventions. The repository gate runs the same commands with an isolated temporary `HOME`,
project directory, credential environment, and operation journal; it never contacts Asana or reads
the real OS credential store.

## Install the Codex skill

Run the preview first, then apply exactly the displayed managed-file plan:

```sh
asana-cli integrations diff --client codex --scope project
asana-cli integrations install --client codex --scope project --dry-run
asana-cli integrations install --client codex --scope project --apply
asana-cli integrations status --client codex --scope project
```

The project adapter writes only its managed skill directory. It does not edit `AGENTS.md`, client
settings, hooks, MCP configuration, or unrelated project files. Removal has the same explicit
preview/apply boundary:

```sh
asana-cli integrations uninstall --client codex --scope project --dry-run
asana-cli integrations uninstall --client codex --scope project --apply
```

## Check authentication exposure

Inspect the client without querying the OS credential store:

```sh
env -u ASANA_ACCESS_TOKEN -u ASANA_PAT asana-cli integrations doctor --client codex --scope project --skip-credential-store
```

`credential_sources.effective` is `none`. When `ASANA_ACCESS_TOKEN` is present, the same command
reports only its source name and an inherited-credential warning; it never returns the value:

```sh
ASANA_ACCESS_TOKEN='replace-with-a-temporary-PAT' asana-cli integrations doctor --client codex --scope project --skip-credential-store
```

Use the hidden `asana-cli auth pat set` prompt on a developer workstation, or inject
`ASANA_ACCESS_TOKEN` from the CI secret store. Never put a real PAT in an argument or committed
file.

## Review host permissions

Print the narrow client-specific guidance:

```sh
asana-cli integrations policy codex
```

Before adding a host rule, make `doctor` classify it. For example, this intentionally unsafe rule is
reported as `permission_review.status: "unsafe"` with a `broad-cli` finding:

```sh
asana-cli integrations doctor --client codex --scope project --skip-credential-store --auto-allow 'Bash(asana-cli *)'
```

Never auto-allow raw `api`, `request`, credential management, `agent apply`, or integration
lifecycle `--apply`. Keep the host sandbox and approval policy enabled.

## Recover an ambiguous write

If an apply reports an unknown outcome, use the operation ID returned when the write was prepared:

```sh
asana-cli agent operation status "$OPERATION_ID"
```

For an `unknown` record, the safe result is
`next_step: "inspect-asana-and-obtain-human-direction"`. The command is local-only and does not need
a PAT. Do not retry the operation: the remote write may already have succeeded. Inspect Asana
separately, then obtain explicit human direction before preparing any new write.

The detailed state and stale-lock rules are in [Operation recovery safety](operation-recovery.md).
