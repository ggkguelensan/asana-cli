## Summary

<!-- What changes, and why? -->

## Contract and risk

- [ ] Public CLI/agent behavior is unchanged, or the protocol and migration are documented.
- [ ] Trust boundaries, filesystem state, and write authorization were considered.
- [ ] `tests/black-box/` remains compiled-binary-only.
- [ ] Generated artifacts were produced by their generator, not edited manually.
- [ ] Changes under the client subject digest have matching fresh evidence.

## Verification

<!-- List exact commands and important manual checks. -->

- [ ] `bun run check:fast`
- [ ] `bun run check`
- [ ] Release-only: `bun run check:release`

## Worktree hygiene

- [ ] The branch has a dedicated worktree or no concurrent agent shares its checkout.
- [ ] No credentials, local state, build output, or unrelated changes are included.
