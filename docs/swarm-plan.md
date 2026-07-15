# Swarm execution plan

Актуально на 2026-07-15. Этот документ задаёт способ выполнения
[roadmap](roadmap.md) через planning/review agents `gpt-terra` и implementation agents
`gpt-sol`/`gpt-luna`.

Связанные документы:

- [Backlog](backlog.md) — стабильные ID задач и зависимости.
- [Implementation plan](implementation-plan.md) — технический порядок `v0.3`/`v0.4`.
- [Security model](../SECURITY.md) — обязательные границы всех реализаций.

Имена `gpt-terra`, `gpt-sol` и `gpt-luna` являются обязательными role/model targets для runner,
который умеет выбирать модели. Если конкретный orchestration API не поддерживает model pinning,
он сохраняет эти роли и явно сообщает, какой доступный backend был назначен фактически.

## Роли

### Integrator

Владеет dependency graph и `main`:

- выбирает bounded wave из backlog;
- фиксирует общий base SHA и file ownership;
- создаёт отдельные worktree/branches;
- не разрешает двум implementation agents одновременно менять hotspot-файлы;
- проводит собственный diff review и общий `bun run check`;
- возвращает findings исполнителю до merge;
- публикует PR и обновляет backlog status после merge.

Integrator не делегирует финальное решение о security boundary, backward compatibility или release.

### `gpt-terra` — planning и review

Работает read-only в двух режимах.

Planning:

- сверяет roadmap/backlog с фактическим кодом;
- строит critical path;
- превращает milestone в PR-sized изменения;
- указывает точные файлы, Zod boundaries, compatibility и тесты;
- предлагает две непересекающиеся задачи для Sol/Luna;
- перечисляет stop/rollback criteria.

Review:

- проверяет commit относительно зафиксированного parent SHA;
- возвращает только конкретные findings с severity и `file:line`;
- отдельно проверяет заявленные security свойства;
- не исправляет код самостоятельно;
- после fixes делает короткий re-review прежних blockers.

### `gpt-sol` — protocol и product surface

Основная линия ownership:

- agent protocol, capabilities, schemas и error contracts;
- read flags, projections и output budgets;
- canonical skill и Generic/Codex adapters;
- Asana reads, project/task context и create-task workflows;
- protocol compatibility и migration documentation.

Sol не меняет operation storage, release/distribution pipeline или Luna-owned client adapters без
нового swarm assignment.

### `gpt-luna` — durability и delivery

Основная линия ownership:

- operation journal, CAS, recovery и audit metadata;
- release gates, provenance, SBOM и platform E2E;
- integration installer engine и managed-file ownership;
- Claude/OpenCode/Cursor adapters;
- policy/storage hardening и reproducibility.

Luna не меняет central agent routing одновременно с Sol. Wiring получает отдельную последовательную
wave после merge соответствующего protocol contract.

## Двухфазный цикл

```text
Terra planning fanout
        │
        ▼
Integrator contract freeze
        │
        ├───────────────┐
        ▼               ▼
   Sol worktree     Luna worktree
        │               │
        └───────┬───────┘
                ▼
       Terra review fanout
                │
                ▼
     Integrator merge + check
                │
                ▼
           Draft PR → CI
                │
                ▼
              main
```

Planning agents завершаются до старта implementation fanout. Исполнители получают не весь
milestone, а одну bounded задачу с разрешёнными/запрещёнными файлами и integration point.

## Git/worktree protocol

Для каждой задачи создаётся отдельный worktree от одного green `origin/main`:

```text
/Users/admin/ticketon/worktrees/asana-cli/sol-<backlog-id>
/Users/admin/ticketon/worktrees/asana-cli/luna-<backlog-id>
```

Ветки:

```text
agent/sol-<backlog-id>-<description>
agent/luna-<backlog-id>-<description>
agent/v<minor>-wave-<number>
```

Правила:

- один agent — один worktree и одна bounded branch;
- implementation agents не работают в основном checkout;
- каждый агент коммитит, но не push-ит и не открывает PR;
- integrator cherry-pick-ит проверенные commits в wave branch;
- downstream branch создаётся только после merge contract dependency;
- `main` не merge-ится в feature branch; при необходимости branch пересоздаётся/rebase-ится;
- generated files изменяет generator, а не агент вручную;
- unrelated user files никогда не stage-ятся автоматически.

## Hotspot ownership lock

В один момент только одна active task может владеть каждым из файлов:

```text
src/agent-cli.ts
src/cli.ts
src/errors.ts
src/help.ts
src/security.ts
src/agent-contract.ts
```

Параллельность достигается созданием новых изолированных модулей и tests, а не одновременным
редактированием hotspot-файлов с надеждой разрешить конфликт позже.

## Выполненные waves

### Wave 1 — merged

- Sol: `AP-001`, `AP-012` — protocol spine, единые версии, минимальный agent status.
- Luna: release preflight — full check, tag/version/main ancestry и безопасная draft publication.
- Результат: [PR #2](https://github.com/ggkguelensan/asana-cli/pull/2), merge `87af7a1`.

### Wave 2 — merged

- Sol: `AP-002`, `AP-003` — Zod action registry, capability catalog, real wire JSON Schemas.
- Luna: `AP-006`, `AP-007` — isolated operation journal core, atomic CAS и fail-closed storage.
- Terra re-review: прежние blocker/high findings закрыты.
- Результат: [PR #3](https://github.com/ggkguelensan/asana-cli/pull/3), merge `37cfe66`.

## Следующие waves

### Wave 3 — безопасный fanout

Sol — `AP-004`:

- stable error-code registry;
- safe mapping validation/auth/policy/conflict/storage/API errors;
- error schema в agent contract;
- compatibility tests без разбора текста.

Ownership: `src/errors.ts`, protocol error module, error-specific tests. На время задачи Sol владеет
`src/security.ts`/`src/agent-contract.ts`, если они действительно нужны.

Luna — `SEC-001` и journal hardening fixtures:

- malicious task/comment fixtures;
- доказательство, что Asana text не выбирает command, URL или operation;
- crash/stale-lock recovery design fixture без unsafe auto-reclaim;
- Windows filesystem/ACL decision record и CI feasibility check.

Ownership: новые security/journal test files и отдельный design reference; без изменений
`agent-cli.ts`, `cli.ts` и `errors.ts`.

Gate: error responses имеют code, не содержат raw transport/secrets; content-trust tests не
эмулируют защиту от unrestricted same-user shell.

### Wave 4 — последовательный hotspot

Сначала Sol — `AP-005`, `AP-011`, `SEC-006`:

- canonical read flags, начинающиеся с `asana-cli`;
- stdin JSON остаётся совместимым input mode;
- `include` selectors и byte budgets;
- Unicode/nesting/pagination limit tests.

После merge Luna — `AP-008`:

- prepare создаёт durable operation;
- apply принимает только `operation_id`;
- old plan-based apply получает machine-readable migration error;
- повторный apply не отправляет второй write request;
- write policy и target guards проверяются повторно.

Эти задачи нельзя выполнять параллельно: обе меняют `agent-cli.ts` и canonical action schemas.

### Wave 5 — завершение v0.3

- Luna: `AP-009`, `AP-010` — state machine wiring, status и explicit stale-lock/ambiguous recovery.
- Sol: `AP-013` — compatibility/deprecation fixtures и migration guidance.
- Luna: `SEC-004`, `SEC-005` — scoped policy и metadata-only audit.

Gate `v0.3`: повторный apply локально невозможен; `unknown` не ретраится; stale/expired operations
имеют безопасный recovery path; v0.2 reads остаются совместимыми.

### v0.4 fanout

Первый параллельный слой:

- Sol: `INT-001`, `INT-002` — canonical skill и references.
- Luna: `INT-003` — declarative Zod client registry.

После merge:

- Luna: `INT-004`, `INT-005`, `REL-001` — generator, embedded bundle, package-content checks.
- Sol: read-only integration command routing.
- Luna: `INT-007`–`INT-009` — atomic installer/ownership/uninstall.
- Sol: `INT-010`, `INT-013`, Codex adapter.
- Luna: Claude adapter.

Terra review проверяет deterministic generation, unmanaged-file preservation и реальные client
discovery/evals до статуса `supported`.

### v0.5–v1.0 ownership

| Milestone | Sol | Luna |
|---|---|---|
| v0.5 | Asana reads/context, create task/subtask | Git context/mapping, memberships/dependencies |
| v0.6 | Gemini и Copilot adapters | OpenCode и Cursor adapters |
| v0.7 | policy profiles и doctor checks | provenance, SBOM, platform E2E, package channels |
| v1.0 | protocol migrations/deprecation/docs | reproducibility и cross-client security suite |

## Required handoff от implementation agent

Каждый agent возвращает:

- commit SHA и parent/base SHA;
- изменённые и намеренно запрещённые файлы;
- выполненные backlog ID;
- запущенные проверки и точный результат;
- известные риски и непроверенные платформы;
- утверждения безопасности, которые реализация **не** делает.

Нельзя возвращать только «готово» без commit и evidence.

## Quality gates

Для каждого implementation commit:

- `bun run check`;
- positive, negative и security tests;
- Zod validation на новых argv/env/file/API/store boundaries;
- no explicit `any`;
- никакие raw SDK/HTTP objects, headers, stacks или credentials не сериализуются;
- существующие совместимые inputs имеют fixtures;
- worktree после проверки чистый.

Перед merge wave:

- два read-only Terra reviews для protocol/storage-sensitive изменений;
- все blocker/high findings исправлены и повторно проверены;
- integrator запускает общий `bun run check` после cherry-pick всех commits;
- PR CI green;
- backlog statuses обновляются только после merge.

## Stop criteria

Wave немедленно останавливается, если:

- credential или task/comment content попадает в audit/error fixture/artifact;
- `unknown` автоматически ретраится;
- два процесса могут одновременно выполнить один `prepared → applying`;
- published schema расходится с runtime или фактическим stdout envelope;
- journal принимает более широкий write payload, чем curated agent schema;
- installer изменяет unmanaged file;
- generated artifacts имеют drift;
- release tag, package version и compiled CLI version расходятся;
- security test flaky или agent client discovery не подтверждён.

Rollback делается revert-коммитом. Опубликованные tags не переписываются, journal format не
понижается, `unknown` не удаляется, а client с проваленным eval переводится в `experimental`.
