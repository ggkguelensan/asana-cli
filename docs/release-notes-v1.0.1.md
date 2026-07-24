# asana-cli v1.0.1

Статус: опубликован
[`v1.0.1`](https://github.com/ggkguelensan/asana-cli/releases/tag/v1.0.1) из exact `main` commit
`da67cf3f06062b2d0a3678fe3936e1563d4937bb`; release workflow завершился успешно.

## Исправление поставки

- Musl Docker gates запускаются под UID/GID GitHub runner, поэтому lifecycle evidence остаётся
  читаемым для `actions/upload-artifact`.
- Executable workflow checker и regression test запрещают возврат к root-owned container output.
- Immutable `v1.0.0` tag не перемещается: его failed workflow не создал частичный GitHub Release.

Product behavior и v1 scope не меняются относительно
[v1.0.0 release notes](release-notes-v1.0.0.md): один безопасный agent protocol, durable writes,
curated developer workflows, supported Codex/Claude integrations и шесть POSIX release targets.
Windows не входит в support или release matrix.
