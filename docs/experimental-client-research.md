# Experimental client research

Pi and Kimi Code CLI are intentionally `experimental`.

Both clients document Agent Skills discovery and accept the canonical `SKILL.md` structure:

- [Pi skills](https://pi.dev/docs/latest/skills) scans `.pi/skills/<name>/SKILL.md` for a
  project and `~/.pi/agent/skills/<name>/SKILL.md` for a user, with `.agents/skills` aliases.
- [Kimi Code skills](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html)
  scans `.kimi-code/skills/<name>/SKILL.md` at project and user scope, with a project
  `.agents/skills` alias.

The adapters therefore use the clients' native brand roots and the exact shared Asana skill
bytes. They have deterministic install/status/update/uninstall coverage and the same display-only
permission guidance as every other adapter.

Neither client has a saved clean-session behavioral/security record in this repository. The
evidence-derived compatibility generator consequently emits `experimental`; adding a root or
passing only artifact tests can never promote a client. Promotion requires the complete discovery,
bounded read, prepare/approval, malicious-content, missing-PAT, ambiguous-outcome, and broad
permission suite.
