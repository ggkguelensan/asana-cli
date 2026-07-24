# Backlog asana-cli

Backlog реализует [roadmap](roadmap.md). Порядок ближайшего выполнения описан в
[implementation plan](implementation-plan.md).

Снимок актуализирован 2026-07-24 после публикации `v1.0.1`. После опубликованного `v0.4.0`
native support новых releases ограничен macOS/Linux. Статус `done` означает, что
acceptance criteria подтверждены кодом и проверками в repository; наличие частичной реализации
само по себе не закрывает задачу.

## Обозначения

Приоритеты:

- `P0` — блокирует безопасную интеграцию с агентами или следующий release milestone.
- `P1` — нужен для заявленного milestone и основного developer workflow.
- `P2` — важное расширение после стабильной основы.
- `P3` — later/experimental.

Статусы:

- `done` — задача merged в `main` и прошла required checks;
- `ready` — зависимости закрыты, но реализация или обязательное evidence ещё не завершены;
- `blocked` — сначала нужны перечисленные зависимости;
- `research` — требуется отдельное техническое решение или проверка клиента.
- `cancelled` — задача явно исключена из продуктового scope и не блокирует зависимости.

ID являются стабильными ссылками для issues, PR и release notes. При переносе задачи в GitHub
Issue ID следует сохранить в заголовке.

## Agent protocol

| ID | P | Статус | Задача | Зависит от | Acceptance criteria |
|---|---|---|---|---|---|
| AP-001 | P0 | done | Формализовать `agent_protocol_version` и `cli_version` в envelope | — | Версии присутствуют в capabilities и каждом agent response; есть compatibility test |
| AP-002 | P0 | done | Расширить capability catalog метаданными action | AP-001 | Для каждой action заданы effect, approval class, input/output schema ID, limits и minimum CLI version |
| AP-003 | P0 | done | Публиковать JSON Schema из runtime Zod-схем | AP-001 | `agent schema` и `agent schema ACTION` возвращают стабильный JSON; schema/runtime не расходятся в тестах |
| AP-004 | P0 | done | Ввести стабильные machine error codes | AP-001 | Validation, auth, policy, stale, expired, conflict, unknown-result и API errors различимы без парсинга текста |
| AP-005 | P0 | done | Добавить flags для read actions | AP-002 | Canonical read command начинается с `asana-cli`; stdin JSON остаётся совместимым интерфейсом |
| AP-006 | P0 | done | Спроектировать Zod-валидируемый durable operation record | AP-001 | Record содержит ID, action, target, immutable payload, guards, timestamps, TTL, state и protocol version |
| AP-007 | P0 | done | Реализовать atomic operation journal с restrictive permissions | AP-006 | Partial write не повреждает journal; чужие/невалидные records отклоняются; task/comment text не логируется отдельно |
| AP-008 | P0 | done | Перевести apply на `--operation-id` | AP-007 | Apply не принимает повторный payload; expired/stale/already-applied operations отклоняются стабильно |
| AP-009 | P0 | done | Реализовать state machine ambiguous outcomes | AP-008 | Состояния `prepared/applying/applied/unknown/expired` покрыты тестами; `unknown` не ретраится автоматически |
| AP-010 | P0 | done | Добавить `agent operation status` и recovery guidance | AP-009 | Пользователь видит безопасный статус и следующий шаг без вывода payload/credential |
| AP-011 | P1 | done | Заменить `include_content` на field selectors и byte budget | AP-003 | Клиент явно выбирает `notes`, `custom_fields` и лимит; превышение возвращает предсказуемый truncated result |
| AP-012 | P1 | done | Минимизировать `agent status` и общие projections | — | Email и другие необязательные PII отсутствуют по умолчанию |
| AP-013 | P1 | done | Добавить protocol compatibility/deprecation tests | AP-001, AP-003 | Старый совместимый клиент получает корректный ответ; несовместимый — machine-readable upgrade guidance |

## Security и policy

| ID | P | Статус | Задача | Зависит от | Acceptance criteria |
|---|---|---|---|---|---|
| SEC-001 | P0 | done | Зафиксировать prompt-injection fixtures для Asana content | — | Task/comment с командами, URL и просьбой вывести env остаётся только данными и не выбирает следующую operation |
| SEC-002 | P0 | done | Добавить credential-source check в doctor | INT-006 | Doctor сообщает `credential_store`/`environment` без значения PAT и предупреждает об inherited PAT |
| SEC-003 | P0 | done | Проверять broad permission examples | INT-010 | Doctor/evals обнаруживают auto-allow для `api`, `request`, `auth` и apply |
| SEC-004 | P1 | done | Workspace/project/custom-field/write-field allowlists | AP-008 | Prepare и apply независимо проверяют scope; policy file валидируется Zod и fail-closed |
| SEC-005 | P1 | done | Metadata-only audit log | AP-009 | Записываются operation ID, target GID, action, timestamps, result и hashes; content/PAT отсутствуют |
| SEC-006 | P1 | done | Добавить output byte-budget tests | AP-011 | Большие API responses не обходят лимиты через nesting, Unicode или pagination |
| SEC-007 | P2 | done | Отдельный OS user/container deployment guide | — | Документированы credential, persistent journal/filesystem и egress boundaries, same-user/root/runtime ограничения и POSIX container pattern без ложных гарантий |

## Skill и integration manager

| ID | P | Статус | Задача | Зависит от | Acceptance criteria |
|---|---|---|---|---|---|
| INT-001 | P0 | done | Создать canonical `asana` Agent Skill | AP-002, AP-005 | Skill вызывает только curated agent actions, не содержит PAT/raw API/install logic и укладывается в progressive disclosure |
| INT-002 | P0 | done | Вынести workflows в короткие thematic references | INT-001 | Read, write, Git context, content trust и errors описаны без дублирования основного skill |
| INT-003 | P0 | done | Создать декларативный Zod-валидируемый client registry | — | Paths, scopes, manifests, support tier и protocol range валидируются на build/test |
| INT-004 | P0 | done | Детерминированный generator client artifacts | INT-001, INT-003 | Повторная генерация даёт byte-identical output; CI обнаруживает drift |
| INT-005 | P0 | done | Встроить generated bundle в Bun executable | INT-004 | Release binary устанавливает точную bundled version без доступа к repository/npm |
| INT-006 | P0 | done | Реализовать `integrations list|detect|status|doctor` | INT-003, INT-005 | Команды не изменяют state, не выводят secrets и объясняют protocol/skill mismatch |
| INT-007 | P0 | done | Реализовать dry-run и managed-file manifest | INT-005 | Preview показывает все target paths; manifest содержит owner, versions и SHA-256 каждого файла |
| INT-008 | P0 | done | Реализовать atomic install/update | INT-007 | Staging/rename не оставляет partial install; unmanaged/modified files не перезаписываются молча |
| INT-009 | P0 | done | Реализовать safe uninstall/diff | INT-007, INT-008 | Удаляются только совпадающие managed files; unrelated client configuration сохраняется |
| INT-010 | P0 | done | Generic `.agents/skills` adapter | INT-008 | User/project install roundtrip и skill validation проходят на temp HOME |
| INT-011 | P0 | done | Codex skills-only plugin adapter | INT-010 | Manifest генерируется из общего skill; нет MCP; clean Codex session обнаруживает skill |
| INT-012 | P0 | done | Claude Code plugin adapter | INT-010 | Plugin не содержит credential и self-update logic; clean Claude session обнаруживает skill |
| INT-013 | P1 | done | `integrations policy CLIENT` | INT-003 | Печатает узкие suggested rules и никогда не применяет broad auto-allow автоматически |
| INT-014 | P1 | done | Реальные behavioral/security evals Codex и Claude | INT-011, INT-012, AP-009 | Read, prepare/approval/apply, malicious content, missing PAT и ambiguous outcome проходят в clean sessions |
| INT-015 | P1 | done | Gemini CLI extension без MCP | INT-014 | Native 0.50.0 validate/install/discovery и policy tests проходят; общий skill не форкнут; без behavioral suite adapter остаётся `experimental` |
| INT-016 | P1 | done | GitHub Copilot CLI skill/plugin | INT-014 | Нет broad `allowed-tools: shell`; native 1.0.74 project discovery и adapter evals проходят; без behavioral suite adapter остаётся `experimental` |
| INT-017 | P1 | done | OpenCode adapter | INT-014 | Shared skill, native 1.18.3 discovery и permission example проходят; без behavioral suite adapter остаётся `experimental` |
| INT-018 | P1 | done | Cursor adapter | INT-014 | Нативный discovery root и lifecycle покрыты; документация честно оставляет shell/apply approval-required; без clean-session evidence adapter остаётся `experimental` |
| INT-019 | P2 | done | Генерируемая compatibility matrix | INT-015, INT-016, INT-017, INT-018 | Статусы `supported`/`experimental`/`generic` получаются из сохранённого evidence; drift блокирует gate |
| INT-020 | P3 | done | Pi/Kimi и другие clients | INT-019 | Native roots исследованы и добавлены как `experimental`; клиент не получает `supported` без полного acceptance suite |

## Developer context и Asana workflows

| ID | P | Статус | Задача | Зависит от | Acceptance criteria |
|---|---|---|---|---|---|
| DEV-001 | P1 | done | Curated reads для projects/sections/memberships | AP-011 | Minimal projections, pagination/result limits и Zod DTO coverage |
| DEV-002 | P1 | done | Custom-field metadata и user resolution | AP-011 | Значения запрашиваются явно; sensitive content не попадает в default projection |
| DEV-003 | P1 | done | `agent context --task` | DEV-001, DEV-002 | Один ограниченный response связывает task, project, section, fields, subtasks и dependencies |
| DEV-004 | P1 | done | Нормализовать Git context | — | Local-only `agent context --git-current` получает ограниченную нормализованную identity без PAT, сети или shell injection |
| DEV-005 | P1 | done | `agent context --git-current-candidates` | DEV-004, AP-011 | Аутентифицированный workspace-scoped поиск возвращает максимум 20 candidates и структурные основания совпадения; empty/single/multiple/truncated result не становится target до явного выбора canonical task GID |
| DEV-006 | P1 | done | Repository-to-Asana mapping | SEC-004, DEV-004 | Host-administered fixed-path strict v1 mapping returns only one exact normalized host + owner/name workspace/project/optional Git-field match through local `agent context --repository-asana`; no PAT/network, no repository-controlled trust, no host-policy/write effect, and generic safe absence/storage errors |
| DEV-007 | P1 | done | Create task/subtask prepare/apply | AP-009, SEC-004 | Preview содержит workspace/project/assignee/fields; apply идемпотентен локально и approval-required |
| DEV-008 | P1 | done | Project/section membership writes | AP-009, DEV-001, SEC-004 | Каждое изменение — отдельная scoped operation с concurrency guards |
| DEV-009 | P2 | done | Dependency writes | AP-009, DEV-003 | Циклы/invalid targets обрабатываются предсказуемо; операция ограничена policy |
| DEV-010 | P2 | done | Attachment metadata | AP-011 | Возвращается только metadata; URL не открываются и файлы не скачиваются автоматически |
| DEV-011 | P2 | done | Batch reads | AP-011 | Общие request/result/byte budgets; partial failures machine-readable |
| DEV-012 | P1 | done | Versioned repository context и exact task aliases | AP-013, DEV-004, DEV-006 | Local/no-PAT/no-network `agent context --repository-context` reads only the fixed-root untrusted strict duplicate-safe v1 manifest; it reports deterministic digest/revision and fully qualified ASCII immutable-GID aliases, with no includes/env/scripts/network, fuzzy fallback, hidden precedence, resolver, or write authority |
| DEV-013 | P1 | done | Central task reference resolver | DEV-001, DEV-002, DEV-005, DEV-012 | `gid`/URL/workspace Custom ID/alias dispatch возвращает only exact GID или bounded `not_found`/`ambiguous`/`stale`; existing GID action schemas остаются неизменны |
| DEV-014 | P1 | done | Human alias lifecycle и worktree-local quick context | DEV-004, DEV-012 | Repository aliases shared across linked worktrees; active/recent state isolated per worktree, CAS replace, bounded retention/erase, owner-only atomic local state and no alias mutation in agent mode |
| DEV-015 | P1 | done | Revisioned task-create templates | DEV-001, DEV-002, DEV-007, DEV-012, SEC-004 | Structured static defaults only; complete immutable expansion preview records template revision/digest and target GIDs; edit after prepare cannot alter apply |
| DEV-016 | P1 | done | Alias/template client security evals | DEV-003, DEV-013, DEV-014, DEV-015, INT-014 | Clean Codex/Claude sessions resolve exact alias, stop on ambiguity, reject malicious context, preserve approval and cannot mutate/list local alias history |
| DEV-017 | P1 | done | Worktree-local agent task binding | DEV-004, DEV-014, DEV-016 | Idempotent human bind/exact deactivate compose with Worktrunk lifecycle hooks; `agent context --worktree-task` exposes only this linked worktree's `bound`/`unbound`/`stale` advisory task and never widens write policy |
| DEV-018 | P1 | done | Compiled-binary black-box contract | DEV-017, INT-019, REL-008 | Standalone suite imports no implementation source, dynamically checks every published agent action schema, all embedded clients in user/project scopes, policy/error/dry-run boundaries, fixed-root Git context and real linked-worktree isolation through `dist/asana-cli` only |

## Release engineering

| ID | P | Статус | Задача | Зависит от | Acceptance criteria |
|---|---|---|---|---|---|
| REL-001 | P0 | done | Package-content tests для embedded skill bundle | INT-005 | Каждый release binary содержит ожидаемые manifests, skills, hashes и versions |
| REL-002 | P1 | done | macOS/Linux integration E2E с temp HOME | INT-010 | Install/status/update/uninstall проходят на supported macOS/Linux targets, не зависят от реального HOME и не трогают пользовательские файлы |
| REL-003 | P1 | done | Signed checksums и provenance | REL-001 | Canonical payload checksums получают GitHub Sigstore bundle; SLSA subject связывает каждый binary с exact tag commit и release workflow; online/offline verification документирован |
| REL-004 | P1 | done | SBOM для release artifacts | REL-001 | Deterministic SPDX 2.3 связывает target binary digest, source commit, Bun, lockfile digest и production closure; отдельный attestation и exact verifier блокируют drift |
| REL-005 | P2 | done | Homebrew distribution | REL-003 | Release-specific POSIX Formula генерируется из тех же artifact bytes, закрепляет четыре checksum, выбирает один executable и сама входит в signed payload set |
| REL-006 | P2 | cancelled | Scoop/Windows channel | — | Native Windows исключён из support/release matrix; исторический `v0.4.0` не переписывается |
| REL-007 | P1 | done | Release compatibility gate | AP-013, INT-014, REL-001 | Каждый target после build/lifecycle выполняет единый contract для protocol, generated skills, support matrix, client evidence, security и exact package content; workflow drift тестируется |
| REL-008 | P0 | done | Исполняемая macOS/Linux support matrix | — | Runtime, build script, CI, release workflow, docs и verifier согласованы; native Windows отсутствует в новых release gates |
| REL-009 | P1 | done | Reproducible build verification | REL-003, REL-004 | Каждый matrix job повторно компилирует тот же target с exact commit/lock/Bun/SOURCE_DATE_EPOCH; release требует byte-identical digest/size и публикует path-free evidence с пустыми differences |
| REL-010 | P1 | done | Machine-readable release evidence manifest | INT-019, REL-002, REL-003, REL-004, REL-007, REL-009 | Deterministic `release-evidence.json` связывает tag/commit, protocol, workflow/contract/lock, шесть target binary и sidecars, Homebrew и evidence-derived client qualifications; его digest входит в signed checksum set |

## v1.0 stabilization

| ID | P | Статус | Задача | Зависит от | Acceptance criteria |
|---|---|---|---|---|---|
| V1-001 | P1 | done | Исполняемые installation/auth/permission/recovery examples | DEV-016, INT-019 | Документированные critical workflows выполняются fixtures и не расходятся с CLI/help/policy |
| V1-002 | P1 | done | Completion и security audit | SEC-002, SEC-003, SEC-007, DEV-016, REL-010, V1-001 | Для каждого критерия roadmap сохранено прямое evidence; critical/high findings отсутствуют |

## Later

| ID | P | Статус | Задача | Зависит от | Acceptance criteria |
|---|---|---|---|---|---|
| LTR-001 | P3 | research | Несколько credential profiles | SEC-004 | Profile selection не раскрывает PAT и однозначно связывается с policy/workspace |
| LTR-002 | P3 | research | OAuth | LTR-001 | Отдельный threat model, secure refresh-token storage и revocation workflow |
| LTR-003 | P3 | research | Events/watch и read cache | AP-013 | Cache bounded, invalidation documented, content защищён restrictive permissions |
| LTR-004 | P3 | research | Attachment upload | SEC-004, DEV-010 | Отдельный threat model для path access, MIME, size и data exfiltration |
| LTR-005 | P3 | ready | Enterprise managed policies | SEC-004, REL-003 | Policy bundle подписан, валидируется и не может ослабляться project config без явного override |

## Definition of Done для любой задачи

- Реализация не расширяет agent access к `auth`, `api call`, `request` или произвольным файлам.
- Новые argv/env/file/API/store границы имеют Zod validation.
- В `src`, `tests` и `scripts` не добавлен явный `any`.
- Добавлены positive, negative и security-relevant tests пропорционально риску.
- Ошибки не сериализуют raw SDK/HTTP objects, headers, stacks или credentials.
- Пользовательская документация и machine help обновлены вместе с поведением.
- `bun run check` проходит на поддерживаемой версии Bun.
