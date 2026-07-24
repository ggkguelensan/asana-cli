# Roadmap asana-cli

Актуально на 2026-07-23. Текущий опубликованный GitHub Release —
[`v0.4.0`](https://github.com/ggkguelensan/asana-cli/releases/tag/v0.4.0), tag указывает на
commit [`81c1b7a`](https://github.com/ggkguelensan/asana-cli/commit/81c1b7afa789527cc52faca8ca300f9f66da63f4).
Следующий продуктовый цикл — `v0.5`; его версия и release tag появятся только после выбора и
завершения release scope.

Связанные документы:

- [Backlog](backlog.md) — приоритизированные задачи, зависимости и acceptance criteria.
- [Release plan](release-plan.md) — последовательный scope и gate каждого release до `v1.0.0`.
- [Implementation plan](implementation-plan.md) — порядок ближайших изменений и PR.
- [Platform support](support-policy.md) — поддерживаемая macOS/Linux release matrix.
- [Critical v1 workflows](v1-workflows.md) — исполняемые installation/auth/permission/recovery examples.
- [Curated developer context](developer-context.md) — bounded project/section/membership/custom-field/user reads.
- [Human local context](local-context.md) — DEV-014 alias/worktree state contract и recovery.
- [Agent task creation](task-creation.md) — direct/subtask prepare/apply и revisioned repository templates.
- [Project and section operations](task-project-operations.md) — exact membership/placement prepare/apply.
- [Task dependency operations](task-dependency-operations.md) — exact relation writes и bounded cycle proof.
- [Bounded batch reads](batch-reads.md) — fixed GET-only Batch API surface и partial outcomes.
- [Agent clients](agent-clients.md) — текущий контракт прямого использования из Codex CLI и Claude Code.
- [Security model](../SECURITY.md) — гарантии, ограничения и threat model.

## Состояние v0.4.0

Снимок на 2026-07-23:

- `v0.4.0` опубликован 2026-07-19 автоматическим
  [release workflow](https://github.com/ggkguelensan/asana-cli/actions/runs/29700955745);
- release содержит семь platform binaries и `SHA256SUMS`; package-content каждого target,
  включая Windows-проверку на Windows runner и musl-проверку в Alpine, прошёл;
- canonical skill, generated bundle, integration manager и Generic Agent Skills lifecycle
  подтверждены repository tests и включены в release;
- clean-session behavioral/security evals Codex и Claude (`INT-011`, `INT-012`, `INT-014`),
  полный supported-platform integration lifecycle E2E (`REL-002`), signed provenance (`REL-003`),
  SBOM (`REL-004`) и полный compatibility gate (`REL-007`) остаются отдельной незакрытой работой;
- публикация release не переводит эти задачи в `done`: статусы определяются их собственными
  acceptance criteria и зафиксированы в [backlog](backlog.md).
- новые releases после `v0.4.0` поддерживают только native macOS/Linux; `REL-008` закрепляет
  runtime/build/CI/release matrix исполняемой проверкой.

## Целевая форма продукта

`asana-cli` должен состоять из трёх независимых слоёв:

```text
Codex / Claude / Gemini / Copilot / Cursor / OpenCode
                         │
                 on-demand skill "asana"
                         │
                asana-cli agent protocol
                         │
       policy · projection · approval · operation journal
                         │
                       Asana
```

1. `asana-cli` — единственный доверенный executable, который владеет credential access,
   Asana API, валидацией, policy enforcement и сериализацией результата.
2. Один переносимый Agent Skill `asana` описывает безопасные workflows и вызывает только
   curated-поверхность `asana-cli agent ...`.
3. Тонкие интеграционные пакеты устанавливают общий skill нативным для клиента способом и
   предоставляют узкие примеры permission policy. Asana-логики в адаптерах быть не должно.

Standalone runtime остаётся одним Bun executable. Устанавливаемые `SKILL.md`, references и
client manifests являются документационными assets, а не отдельными runtime-компонентами.

## Принципы

- Без MCP: агентские клиенты вызывают CLI напрямую.
- Один источник истины для skill; клиентские пакеты генерируются из него.
- Agent Skill загружается по необходимости, а не внедряется в каждую сессию глобальным hook.
- Human API, generic `node-asana`/REST и curated agent protocol остаются разными поверхностями.
- PAT не принимается через argv и не передаётся агенту. Для локальных агентов предпочтителен
  системный credential manager, а не унаследованное окружение.
- Asana content считается недоверенными внешними данными, а не инструкциями.
- Без универсального sanitizer: используются структурная проекция, явные поля, byte budgets и
  exact-value redaction только для известных процессу credentials.
- Все внешние IO-границы валидируются Zod; явный `any` в проекте запрещён.
- Read, prepare и apply имеют разные эффекты и разные требования к approval.
- Установка интеграции по умолчанию изменяет только файлы, которыми владеет `asana-cli`.
- Клиент получает статус `supported` только после поведенческих evals в чистой сессии.

## Не-цели

- MCP server или дублирование официального Asana MCP.
- Запуск и управление жизненным циклом Codex, Claude или других agent processes.
- Автоматическая установка/обновление бинарника по инициативе агента.
- Молчаливое редактирование `AGENTS.md`, `CLAUDE.md`, hooks или пользовательских settings.
- Доступ agent skill к `api call`, `request`, credential management или произвольным файлам.
- Обещание полной изоляции от агента с unrestricted shell от имени того же OS user.
- Заявленная поддержка большого числа клиентов без discovery smoke tests и security evals.

## v0.3 — Safe Agent Protocol

Цель: превратить текущую curated-поверхность в стабильный, версионированный machine contract,
на который может безопасно опираться общий skill.

План:

- формализовать `agent_protocol_version`, `cli_version` и capability catalog;
- публиковать JSON Schema для каждой action из тех же Zod-схем, что используются runtime;
- добавить стабильные machine-readable error codes;
- дать read-командам обычные flags, чтобы canonical invocation начинался с `asana-cli`, сохранив
  JSON stdin как программный интерфейс;
- заменить повторную передачу write plan на durable `operation_id` с TTL и локальным journal;
- добавить состояния `prepared`, `applying`, `applied`, `unknown`, `expired`;
- запретить автоматический retry после неоднозначного результата записи;
- добавить `include`/field selectors и `max_content_bytes` вместо одного широкого переключателя;
- убрать необязательные персональные данные, включая email, из минимальных agent projections;
- покрыть protocol, operation state machine и ambiguous network outcomes интеграционными тестами.

Gate выхода:

- skill может обнаружить версию и возможности CLI без разбора help-текста;
- read/prepare правила можно отличить от apply по argv-prefix;
- повторный локальный apply одной операции не создаёт повторную запись;
- неоднозначный сетевой результат становится `unknown` и не ретраится автоматически;
- все новые IO-границы проходят Zod validation и no-`any` guard.

Статус: реализован и включён в `v0.4.0`; operation status, recovery guidance, scoped write policy,
metadata-only audit и protocol compatibility покрыты repository tests.

## v0.4 — Portable skill и integration manager

Цель: поставить один безопасный workflow в Generic Agent Skills, Codex и Claude Code без MCP и
ручного копирования инструкций.

План:

- создать canonical `skills/source/asana/SKILL.md` и небольшие тематические references;
- добавить декларативный, Zod-валидируемый registry клиентов;
- детерминированно генерировать client manifests из общего источника;
- встроить готовый skill bundle в Bun executable;
- реализовать `integrations list|detect|install|status|diff|update|uninstall|doctor|policy`;
- поддержать `user` и `project` scope, `--dry-run` и preview изменений;
- выполнять установку через staging и atomic rename;
- хранить managed-file manifest с SHA-256 каждого файла, CLI/protocol version и ownership;
- отказываться перезаписывать unmanaged или повреждённые файлы без явного действия пользователя;
- поставить Generic `.agents/skills`, Codex skills-only plugin и Claude Code plugin;
- добавить install/update/uninstall roundtrip и реальные client discovery evals.

Gate выхода:

- CLI устанавливает exact-compatible skill bundle без отдельного runtime;
- status/diff обнаруживают ручные изменения по содержимому, а не только по version stamp;
- uninstall сохраняет все файлы и настройки, которыми `asana-cli` не владеет;
- чистые сессии Codex и Claude находят skill и используют curated agent protocol;
- plugin/skill никогда не устанавливает и не обновляет CLI самостоятельно.

Статус: `v0.4.0` опубликован. Автоматические build/package-content и repository lifecycle tests
пройдены; clean-session Codex/Claude eval evidence и полный platform integration E2E остаются
открытыми задачами и не подразумеваются фактом публикации.

## v0.5 — Developer context

Цель: покрыть типичный workflow разработчика без fallback на generic `api call`.

План:

- curated reads для projects, sections, memberships, custom fields и user resolution;
- implementation candidate: bounded task context с subtasks, dependencies, dependents и
  attachment metadata без URL projection или автоматического скачивания;
- создание task/subtask через prepare/apply;
- добавление/удаление задачи из project, перенос между sections и управление dependencies через
  отдельные immutable operations с bounded cycle proof;
- `agent context --task TASK_GID` для компактной рабочей выборки;
- local-only `agent context --git-current` для нормализованной Git identity текущего worktree без PAT или сети;
- отдельный authenticated `agent context --git-current-candidates --workspace GID [--all-assignees] [--completed|--no-completed] [--field GID]` для максимум 20 Asana-кандидатов по этой identity; metadata/evidence остаются untrusted, а explicit canonical GID нужен для follow-up;
- completed DEV-006 host-administered fixed-path repository-to-Asana mapping: local-only `agent context --repository-asana` returns one exact normalized host + owner/name workspace/project/optional Git-field match, requires no PAT/network, and never affects write policy, prepare/apply, or DEV-005 flags without explicit caller handoff;
- GET-only batch reads максимум для 10 exact task GIDs с общими request/result/byte limits и
  machine-readable partial failures;
- implementation candidate: exact task references use canonical `gid:`, v0/v1 `url:`,
  workspace-qualified `custom:`, and fully qualified `task:<project>/<alias>` forms; a title,
  Git token or search result remains candidate evidence, not a write target;
- deterministic `slug-v1` for display aliases: vendored Unicode/transliteration rules, lowercase ASCII output, and a stable code/GID locator before the decorative title slug; renamed titles do not retarget an alias;
- completed DEV-012 repository context: local-only `agent context --repository-context` reads exactly the untrusted fixed-root `.asana-cli/repository-context.json` v1 manifest (bounded strict project/section/custom-field/task mappings, revision and fresh semantic digest) without a PAT or network. It exposes exact canonical `task:<project>/<alias>` immutable-GID aliases but never resolves, selects, injects, authorizes, merges, or establishes precedence; no includes, interpolation, scripts, URLs, repository-defined authorization, or cache exist. DEV-013 owns resolution, DEV-014 lifecycle/state, and DEV-015 templates;
- human-only alias lifecycle (`set`, explicit CAS `replace`, `remove`, `activate`, bounded
  history/clear) and local `quick` locator; aliases are shared by linked worktrees, while
  active/recent selection is worktree-local. This stores no task card/content and performs no
  network read; authenticated task context and repository-alias resolution remain separate
  DEV-003/DEV-013 actions and never inspect this human state;
- exact `agent resolve-task --reference` returns one live GID or bounded
  `not-found`/`ambiguous`/`stale`; `agent context --git-current-candidates` remains a separate
  candidate surface and never selects implicitly;
- owner-controlled local context state outside the checkout: versioned Zod snapshots, opaque repository/worktree identities, atomic locked updates, retention/erasure, restrictive permissions and no task/comment content, credentials, raw paths, remotes or branch names;
- live revalidation before prepare/apply: aliases/templates resolve to immutable GIDs, but host policy, membership, owner and concurrency guards remain authoritative;
- no persistent task cache in v0.5; cache/invalidation and explicitly stale offline reads remain LTR-003 work.

Gate выхода:

- агент может разрешить repository alias только в один canonical GID; multiple, stale or truncated resolution останавливается на bounded candidates без implicit selection;
- агент может найти связанную с текущей веткой/коммитом задачу, прочитать нужный context, подготовить одну template-based или direct операцию и применить её только после approval;
- alias, active worktree context и repository manifest никогда не расширяют write scope: перед prepare и apply повторно проверяются live task state и host policy;
- обычный developer workflow не требует `api call` или `request`, а write по-прежнему ограничен policy, одной immutable operation и явным apply.

## v0.6 — Multi-client support

Цель: расширить тот же contract на другие agent clients без копирования Asana-логики.

План:

- Gemini CLI extension без MCP;
- GitHub Copilot CLI skill/plugin без широкого `allowed-tools: shell`;
- OpenCode shared skill и permission example;
- Cursor shared skill; apply остаётся approval-required из-за coarse shell permissions;
- Pi и Kimi как experimental до прохождения полного набора evals;
- генерируемая compatibility matrix с `supported`, `experimental` и `generic` уровнями;
- тесты generated artifacts и drift между общим skill и client packages.

Gate выхода для каждого `supported` клиента:

- install/uninstall roundtrip;
- skill discovery в чистой сессии;
- read eval и write-confirmation eval;
- malicious-content eval;
- missing-PAT workflow без просьбы вставить PAT в chat;
- auth, raw API и apply не получают лишнего auto-approval.

## v0.7 — Policy и доверенная поставка

Цель: сделать ограничения и provenance проверяемыми в командной и enterprise-среде.

План:

- workspace/project/custom-field/write-field allowlists;
- profiles policy для разных repositories;
- metadata-only audit log без task/comment content и credentials;
- проверка слишком широких agent-client permissions через `integrations doctor`;
- release bundles для всех поддерживаемых платформ;
- подписанные checksums, SBOM и build provenance;
- Homebrew и проверяемые Linux-каналы поставки;
- проверка совместимости CLI, skill bundle и agent protocol при update;
- macOS/Linux E2E с временным HOME и credential-store fixtures.

Gate выхода:

- пользователь может проверить происхождение бинарника и embedded skill bundle;
- policy одинаково применяется независимо от agent client;
- release automation блокируется при contract, security или integration regression.

## v1.0 — Стабильный agent-native Asana CLI

Критерии:

- опубликована политика protocol compatibility, migrations и deprecation;
- поддерживаемые клиенты проходят единый набор behavioral/security evals;
- releases воспроизводимы и содержат provenance;
- critical developer workflows покрыты curated actions;
- отсутствуют известные critical/high security gaps;
- документация установки, auth, permissions и восстановления после ambiguous operations полна и
  проверяется тестами примеров.

## После v1.0

- несколько auth profiles и OAuth;
- events/watch и локальный read cache;
- attachment upload после отдельного threat-model review;
- enterprise managed policy bundles;
- расширенные batch workflows;
- дополнительные agent clients только по результатам реальных acceptance tests.
