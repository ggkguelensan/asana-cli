# Security model

## What this CLI guarantees

- PAT is accepted only from `ASANA_ACCESS_TOKEN`, `ASANA_PAT`, or the OS credential store.
- PAT is never accepted in argv and is never intentionally printed.
- The active PAT and other credential-looking environment values known to the process are redacted by exact value before stdout/stderr serialization.
- SDK `Collection` objects are converted to plain DTOs using only `data` and `next_page`; `_apiClient` is never serialized.
- Raw SuperAgent errors, request objects, request headers and stacks are never printed.
- `*WithHttpInfo` SDK methods are unavailable.
- The raw REST surface pins the Asana origin, requires relative paths, and rejects redirects.
- Bun runtime autoload of `.env`, `bunfig.toml`, `tsconfig.json` and `package.json` is disabled in the standalone executable.
- `BUN_CONFIG_VERBOSE_FETCH` is disabled and execution fails closed when TLS verification is disabled.

## What this CLI cannot guarantee

There is no reliable generic algorithm that can identify every secret already written into an Asana task, custom field, comment, project name or user name. The CLI intentionally does not claim that regex or entropy scoring solves this problem.

Agent output is therefore marked `external-untrusted`. Exact credentials already known to the CLI are redacted; unknown secrets in Asana content may still be returned when the caller explicitly requests content such as notes or comments.

Likewise, a process with arbitrary shell execution as the same OS user may be able to access the same environment, files or credential store without using `asana-cli`. A local executable is not an isolation boundary against an unrestricted same-user agent.

## Direct agent contract

Codex CLI and Claude Code must use only `asana-cli agent ...`, not the human/developer `api` or `request` surfaces.

- List/search/get default to minimal metadata.
- Notes and custom-field values require `get-task` with `include_content: true`.
- Comments require the dedicated `list-comments` action.
- Agent input is one JSON object on stdin, limited to 64 KiB.
- Result counts, string lengths and nesting are capped.
- Task/Asana text is returned as data only and never selects a command, URL, file path or subsequent operation.
- No attachment or URL is followed automatically.
- Writes use `prepare-*` and `apply-*`; one invocation targets one task.
- Agent writes are restricted to tasks assigned to the authenticated user.
- Outbound payloads containing a credential already registered from the local process environment are blocked.

Prepare/hash/policy flags prevent mistakes and stale writes. They do not prove human approval. Codex/Claude permissions and sandboxing must keep `apply-*` behind an external confirmation.

## Recommended deployment

1. Prefer a dedicated least-privileged Asana account whose workspace/project membership is limited to the tasks the agent needs.
2. Run `asana-cli auth pat set` before starting the agent, then remove PAT variables from the agent's parent shell.
3. Keep network and filesystem permissions minimal.
4. Allow only exact read/prepare command prefixes. Never allow broad `asana-cli *`, `api call`, `request`, or shell bypass modes.
5. Require human approval for `apply-task-update` and `apply-comment`.
6. Treat every task, note and comment as potentially hostile prompt-injection content.
7. Rotate/revoke the PAT in Asana Developer Console immediately after suspected exposure.

For stronger isolation, run the CLI under a separate OS user or container with only the Asana credential and access to `app.asana.com`, without repository secrets, SSH agent, cloud credentials or broad shell/network access.

## Reporting a vulnerability

Please use the repository's GitHub Security Advisory flow instead of opening a public issue containing exploit details or credentials. Never include a real PAT in a report.
