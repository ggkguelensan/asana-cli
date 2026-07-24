# Release plan до v1.0.0

Этот документ задаёт последовательные release scopes и проверяемые выходные gate. Backlog ID
остаются источником истины для отдельных задач; [implementation plan](implementation-plan.md)
задаёт ближайший технический порядок, а [support policy](support-policy.md) — обязательную
platform matrix.

## Базовая линия: v0.4.0

Опубликованный `v0.4.0` закрепил versioned agent protocol, durable prepare/apply, scoped policy,
metadata-only audit, portable skill и integration manager. Исторический release неизменяем;
новая platform policy применяется только к следующему release.

## v0.5 — законченный developer workflow

Backlog scope: `DEV-014`, `DEV-001`, `DEV-002`, `DEV-003`, `DEV-013`, `DEV-007`, `DEV-015`,
`DEV-008`, `DEV-009`, `DEV-010`, `DEV-011`, `SEC-002`, `SEC-003`, `INT-011`, `INT-012`,
`INT-014`, `REL-002`, `REL-008`.

Порядок:

1. Зафиксировать macOS/Linux support matrix и executable gate (`REL-008`).
2. Реализовать alias/local-state foundation (`DEV-014`).
3. Добавить bounded project/custom-field/user reads (`DEV-001`, `DEV-002`), затем task context и
   exact resolver (`DEV-003`, `DEV-013`).
4. Добавить create task/subtask и immutable templates (`DEV-007`, `DEV-015`).
5. Закрыть membership/dependency/attachment/batch workflows (`DEV-008`–`DEV-011`).
6. Завершить doctor permission checks и clean-session Codex/Claude evidence
   (`SEC-002`, `SEC-003`, `INT-011`, `INT-012`, `INT-014`).
7. Прогнать integration lifecycle на поддерживаемых macOS/Linux targets (`REL-002`).

Gate:

- типичный developer workflow не использует `api call` или `request`;
- alias/candidate никогда не становится write target неявно;
- каждый write проходит immutable prepare, внешний approval и apply;
- Codex и Claude имеют сохранённое clean-session behavioral/security evidence;
- `bun run check` и native macOS/Linux lifecycle E2E зелёные.

Статус реализации: завершён.

## v0.6 — подтверждённая multi-client доставка

Backlog scope: `DEV-016`, `INT-015`, `INT-016`, `INT-017`, `INT-018`, `INT-019`, `INT-020`.

Порядок:

1. Выполнить alias/template security evals в Codex и Claude (`DEV-016`).
2. Добавить Gemini, Copilot, OpenCode и Cursor adapters без форка Asana-логики
   (`INT-015`–`INT-018`).
3. Генерировать compatibility matrix только из сохранённого evidence (`INT-019`).
4. Провести bounded research Pi/Kimi; оставлять их experimental, пока полный suite не доказан
   (`INT-020`).

Gate каждого supported клиента: native install/uninstall, clean discovery, bounded read,
write-confirmation, malicious-content, missing-PAT и permission evals. Клиент без полного evidence
остаётся `experimental` или `generic`.

Статус реализации: завершён; Codex/Claude Code — `supported`, остальные уровни выведены из
сохранённого evidence.

## v0.7 — проверяемая поставка

Backlog scope: `REL-003`, `REL-004`, `REL-005`, `REL-007`, `SEC-007`.
`REL-006` отменён вместе с native Windows support.

Порядок:

1. Публиковать signed checksums/provenance и SBOM (`REL-003`, `REL-004`).
2. Блокировать release при protocol, generated-skill, package-content или client-eval regression
   (`REL-007`).
3. Добавить Homebrew distribution с проверяемым checksum (`REL-005`).
4. Проверить и документировать отдельный OS user/container deployment (`SEC-007`).

Gate: каждый artifact связан с immutable source commit/workflow, имеет SBOM и проходит одинаковые
contract/security gates; release procedure не требует ручной загрузки или непроверяемого binary.

Статус реализации: завершён как обязательный future-release gate.

## v1.0.0 — стабилизация и доказательство полноты

Backlog scope: `REL-009`, `REL-010`, `V1-001`, `V1-002`.

Порядок:

1. Сравнить повторные builds и публиковать reproducibility evidence (`REL-009`).
2. Сформировать machine-readable release evidence manifest (`REL-010`).
3. Исполнять installation/auth/permission/recovery examples как fixtures (`V1-001`).
4. Провести requirement-by-requirement completion и security audit (`V1-002`).

Gate:

- все pre-1.0 backlog задачи имеют `done` или явно принятое `cancelled` решение;
- protocol compatibility/deprecation и recovery документированы и проверены;
- каждый supported client проходит один и тот же behavioral/security suite;
- supported artifacts воспроизводимы, имеют provenance и SBOM;
- отсутствуют незакрытые critical/high security findings;
- completion audit содержит прямое evidence для каждого критерия roadmap `v1.0`.

Статус реализации: gate закрыт и проверяется `bun run check:v1-audit`; детали и ограничения
зафиксированы в [v1 completion audit](v1-completion-audit.md). Immutable tag `v1.0.0` не стал
GitHub Release из-за artifact-upload permissions; recovery candidate `1.0.1` сохраняет тот же
product scope и исправляет ownership musl evidence перед новым maintainer release action.
