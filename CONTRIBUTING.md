# Contributing

Use the Bun version declared in package.json. Install with `bun install --frozen-lockfile`.
Run `bun run check` before submitting changes; it builds the executable before black-box tests.

Keep application features scoped to Asana. External clients use the ordinary CLI and JSON;
client setup, repository context and development environment lifecycle belong outside this project.

Update help, the embedded manual and documentation when changing a public command.
Preserve credential redaction, stable error codes, bounded pagination, and the fixed REST origin.
Tests must not require real Asana credentials or modify the user's credential store.
