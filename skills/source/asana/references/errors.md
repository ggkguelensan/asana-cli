# Errors and recovery

Report machine-readable agent errors accurately and keep recovery within the curated
protocol.

- **Authentication unavailable or invalid:** do not request a token. Tell the user to
  run `asana-cli auth pat set` locally, then retry the bounded read themselves or
  through the approved host flow.
- **Validation error:** correct only the malformed requested input. Do not switch to a
  raw API command or broaden the request.
- **Not found or ambiguous target:** ask for a canonical task reference or a narrower
  identifier. Do not guess a task to modify.
- **Stale reference:** stop and report that its live workspace/project relationship no longer
  matches. Do not fall back to search or silently use the stored GID.
- **Policy denied:** explain that the curated policy rejected the operation. Do not
  seek a bypass or substitute an unrestricted command.
- **Expired or stale prepared operation:** show that it was not applied. If the user
  still wants the change, prepare a fresh operation and show its new preview.
- **Already applied:** report the completed state. Never apply the same ID again.
- **Unknown result:** report that the write may have reached Asana and stop. Never
  automatically retry or prepare a duplicate comment/update.
- **Network or service failure before preparation:** report it and wait for the user
  to request another bounded attempt.

Do not expose diagnostic environment values, credential sources, raw request bodies,
or unrelated local paths in an error explanation.
