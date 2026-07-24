# asana-cli v1.0.0

Статус: immutable tag существует, но GitHub Release не был опубликован. Release workflow
остановился на загрузке root-owned musl lifecycle evidence; tag не перемещается и не удаляется.
Исправление поставляется отдельным recovery release `v1.0.1`.

## Основные изменения

- Один versioned agent protocol для terminal agents без отдельного MCP server.
- Durable `prepare` → external approval → `apply`, owner-only operation journal и запрет
  автоматического retry после неоднозначного результата.
- Curated developer workflows: bounded reads, task context, exact aliases, immutable templates,
  project membership, dependencies, attachments и bounded batch operations.
- Один portable skill и девять client adapters. Codex и Claude Code имеют полный supported
  behavioral/security evidence; остальные adapters остаются experimental или generic, пока
  тот же suite не будет доказан.
- Шесть native POSIX artifacts: macOS arm64/x64, Linux glibc arm64/x64 и Linux musl arm64/x64.
- Homebrew distribution, SPDX SBOM, byte-identical rebuild evidence, SLSA/SPDX attestations,
  signed checksums и machine-readable release evidence manifest.

## Границы безопасности

- Любая запись требует immutable prepared operation и отдельного approval перед `apply`.
- Alias, search candidate и содержимое Asana никогда не становятся write target неявно.
- Operation journal хранится локально с owner-only permissions; PAT и task/comment content не
  попадают в audit metadata или release evidence.
- Неоднозначный network result получает состояние `unknown`; автоматическое повторение запрещено
  до явной проверки результата.

## Breaking changes после v0.4.0

- Новые releases не содержат Windows artifact и официально поддерживают только POSIX-системы:
  macOS и Linux.
- Write workflow использует operation ID: legacy direct-write envelope отклоняется с migration
  guidance.
- Integration lifecycle разделяет preview/dry-run и явный apply.

Agent protocol v2 сохраняет документированную совместимость с read-envelope `v0.2`.

## Обновление

1. Установите binary для своей POSIX-платформы и проверьте checksum, provenance и SBOM.
2. Запустите `asana-cli agent capabilities` и проверьте protocol/action metadata.
3. Просмотрите изменения интеграции через `asana-cli integrations update --dry-run`.
4. Примените их отдельной командой только после проверки diff.

Подробности проверки release artifacts приведены в
[release verification guide](release-verification.md), а exact support matrix — в
[platform support policy](support-policy.md).
