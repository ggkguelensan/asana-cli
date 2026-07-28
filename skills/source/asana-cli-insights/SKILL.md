---
name: asana-cli-insights
description: Analyze metadata-only local asana-cli history and suggest improvements without exposing Asana content or credentials.
---

# Asana CLI insights

Use `asana-cli insights` to review local invocation metadata. The log contains command categories,
outcomes, durations, effects, and normalized error codes. It intentionally excludes free-form
argument values, GIDs, paths, task/comment content, and credentials.

## Procedure

1. Run `asana-cli insights --days 30`.
2. Explain the strongest observations first: success rate, common commands, recurring error classes,
   and whether maintenance checks are being used.
3. Turn deterministic recommendations into practical next steps. Do not claim to know task content,
   project quality, employee performance, or intent from metadata.
4. If more context is needed, ask the user; do not inspect unrelated local files or expand into raw
   Asana reads automatically.
5. Ask the user to run `asana-cli doctor` for installation/auth diagnostics; agent mode cannot
   inspect human installation paths or credential state. Use `asana-cli man insights` for details.

Insights are advisory and perform no Asana writes.
