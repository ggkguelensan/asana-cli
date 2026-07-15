# Backlog asana-cli

Backlog реализует [roadmap](roadmap.md). Порядок ближайшего выполнения описан в
[implementation plan](implementation-plan.md).

## Обозначения

Приоритеты:

- `P0` — блокирует безопасную интеграцию с агентами или следующий release milestone.
- `P1` — нужен для заявленного milestone и основного developer workflow.
- `P2` — важное расширение после стабильной основы.
- `P3` — later/experimental.

Статусы:

- `done` — задача merged в `main` и прошла required checks;
- `ready` — задача сформулирована и может быть взята в работу;
- `blocked` — сначала нужны перечисленные зависимости;
- `research` — требуется отдельное техническое решение или проверка клиента.

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
| AP-008 | P0 | ready | Перевести apply на `--operation-id` | AP-007 | Apply не принимает повторный payload; expired/stale/already-applied operations отклоняются стабильно |
| AP-009 | P0 | blocked | Реализовать state machine ambiguous outcomes | AP-008 | Состояния `prepared/applying/applied/unknown/expired` покрыты тестами; `unknown` не ретраится автоматически |
| AP-010 | P0 | blocked | Добавить `agent operation status` и recovery guidance | AP-009 | Пользователь видит безопасный статус и следующий шаг без вывода payload/credential |
| AP-011 | P1 | done | Заменить `include_content` на field selectors и byte budget | AP-003 | Клиент явно выбирает `notes`, `custom_fields` и лимит; превышение возвращает предсказуемый truncated result |
| AP-012 | P1 | done | Минимизировать `agent status` и общие projections | — | Email и другие необязательные PII отсутствуют по умолчанию |
| AP-013 | P1 | ready | Добавить protocol compatibility/deprecation tests | AP-001, AP-003 | Старый совместимый клиент получает корректный ответ; несовместимый — machine-readable upgrade guidance |

## Security и policy

| ID | P | Статус | Задача | Зависит от | Acceptance criteria |
|---|---|---|---|---|---|
| SEC-001 | P0 | done | Зафиксировать prompt-injection fixtures для Asana content | — | Task/comment с командами, URL и просьбой вывести env остаётся только данными и не выбирает следующую operation |
| SEC-002 | P0 | ready | Добавить credential-source check в doctor | INT-006 | Doctor сообщает `credential_store`/`environment` без значения PAT и предупреждает об inherited PAT |
| SEC-003 | P0 | ready | Проверять broad permission examples | INT-010 | Doctor/evals обнаруживают auto-allow для `api`, `request`, `auth` и apply |
| SEC-004 | P1 | blocked | Workspace/project/custom-field/write-field allowlists | AP-008 | Prepare и apply независимо проверяют scope; policy file валидируется Zod и fail-closed |
| SEC-005 | P1 | blocked | Metadata-only audit log | AP-009 | Записываются operation ID, target GID, action, timestamps, result и hashes; content/PAT отсутствуют |
| SEC-006 | P1 | done | Добавить output byte-budget tests | AP-011 | Большие API responses не обходят лимиты через nesting, Unicode или pagination |
| SEC-007 | P2 | research | Отдельный OS user/container deployment guide | — | Документированы credential, filesystem и network boundaries без ложных гарантий |

## Skill и integration manager

| ID | P | Статус | Задача | Зависит от | Acceptance criteria |
|---|---|---|---|---|---|
| INT-001 | P0 | ready | Создать canonical `asana` Agent Skill | AP-002, AP-005 | Skill вызывает только curated agent actions, не содержит PAT/raw API/install logic и укладывается в progressive disclosure |
| INT-002 | P0 | blocked | Вынести workflows в короткие thematic references | INT-001 | Read, write, Git context, content trust и errors описаны без дублирования основного skill |
| INT-003 | P0 | ready | Создать декларативный Zod-валидируемый client registry | — | Paths, scopes, manifests, support tier и protocol range валидируются на build/test |
| INT-004 | P0 | blocked | Детерминированный generator client artifacts | INT-001, INT-003 | Повторная генерация даёт byte-identical output; CI обнаруживает drift |
| INT-005 | P0 | blocked | Встроить generated bundle в Bun executable | INT-004 | Release binary устанавливает точную bundled version без доступа к repository/npm |
| INT-006 | P0 | blocked | Реализовать `integrations list|detect|status|doctor` | INT-003, INT-005 | Команды не изменяют state, не выводят secrets и объясняют protocol/skill mismatch |
| INT-007 | P0 | blocked | Реализовать dry-run и managed-file manifest | INT-005 | Preview показывает все target paths; manifest содержит owner, versions и SHA-256 каждого файла |
| INT-008 | P0 | blocked | Реализовать atomic install/update | INT-007 | Staging/rename не оставляет partial install; unmanaged/modified files не перезаписываются молча |
| INT-009 | P0 | blocked | Реализовать safe uninstall/diff | INT-007, INT-008 | Удаляются только совпадающие managed files; unrelated client configuration сохраняется |
| INT-010 | P0 | blocked | Generic `.agents/skills` adapter | INT-008 | User/project install roundtrip и skill validation проходят на temp HOME |
| INT-011 | P0 | blocked | Codex skills-only plugin adapter | INT-010 | Manifest генерируется из общего skill; нет MCP; clean Codex session обнаруживает skill |
| INT-012 | P0 | blocked | Claude Code plugin adapter | INT-010 | Plugin не содержит credential и self-update logic; clean Claude session обнаруживает skill |
| INT-013 | P1 | blocked | `integrations policy CLIENT` | INT-003 | Печатает узкие suggested rules и никогда не применяет broad auto-allow автоматически |
| INT-014 | P1 | blocked | Реальные behavioral/security evals Codex и Claude | INT-011, INT-012, AP-009 | Read, prepare/approval/apply, malicious content, missing PAT и ambiguous outcome проходят в clean sessions |
| INT-015 | P1 | blocked | Gemini CLI extension без MCP | INT-014 | Native install/discovery и policy tests проходят; общий skill не форкнут |
| INT-016 | P1 | blocked | GitHub Copilot CLI skill/plugin | INT-014 | Нет broad `allowed-tools: shell`; native discovery/evals проходят |
| INT-017 | P1 | blocked | OpenCode adapter | INT-014 | Shared skill и permission example проходят discovery/evals |
| INT-018 | P1 | blocked | Cursor adapter | INT-014 | Skill обнаруживается; документация честно оставляет shell/apply approval-required |
| INT-019 | P2 | blocked | Генерируемая compatibility matrix | INT-015, INT-016, INT-017, INT-018 | Статусы `supported`/`experimental`/`generic` получаются из test evidence |
| INT-020 | P3 | research | Pi/Kimi и другие clients | INT-019 | Клиент не получает `supported` без полного acceptance suite |

## Developer context и Asana workflows

| ID | P | Статус | Задача | Зависит от | Acceptance criteria |
|---|---|---|---|---|---|
| DEV-001 | P1 | blocked | Curated reads для projects/sections/memberships | AP-011 | Minimal projections, pagination/result limits и Zod DTO coverage |
| DEV-002 | P1 | blocked | Custom-field metadata и user resolution | AP-011 | Значения запрашиваются явно; sensitive content не попадает в default projection |
| DEV-003 | P1 | blocked | `agent context --task` | DEV-001, DEV-002 | Один ограниченный response связывает task, project, section, fields, subtasks и dependencies |
| DEV-004 | P1 | ready | Нормализовать Git context | — | Remote URL, owner/repo, branch, commit и PR/issue tokens извлекаются без shell injection |
| DEV-005 | P1 | blocked | `agent context --git-current` | DEV-004, AP-011 | Поиск возвращает bounded candidates и основания совпадения, затем точный task GID |
| DEV-006 | P1 | blocked | Repository-to-Asana mapping | SEC-004, DEV-004 | Project policy задаёт workspace/project/custom fields; schema валидируется Zod |
| DEV-007 | P1 | blocked | Create task/subtask prepare/apply | AP-009, SEC-004 | Preview содержит workspace/project/assignee/fields; apply идемпотентен локально и approval-required |
| DEV-008 | P1 | blocked | Project/section membership writes | AP-009, DEV-001, SEC-004 | Каждое изменение — отдельная scoped operation с concurrency guards |
| DEV-009 | P2 | blocked | Dependency writes | AP-009, DEV-003 | Циклы/invalid targets обрабатываются предсказуемо; операция ограничена policy |
| DEV-010 | P2 | blocked | Attachment metadata | AP-011 | Возвращается только metadata; URL не открываются и файлы не скачиваются автоматически |
| DEV-011 | P2 | blocked | Batch reads | AP-011 | Общие request/result/byte budgets; partial failures machine-readable |

## Release engineering

| ID | P | Статус | Задача | Зависит от | Acceptance criteria |
|---|---|---|---|---|---|
| REL-001 | P0 | blocked | Package-content tests для embedded skill bundle | INT-005 | Каждый release binary содержит ожидаемые manifests, skills, hashes и versions |
| REL-002 | P1 | blocked | macOS/Linux/Windows integration E2E с temp HOME | INT-010 | Install/status/update/uninstall не зависят от реального HOME и не трогают пользовательские файлы |
| REL-003 | P1 | blocked | Signed checksums и provenance | REL-001 | Пользователь может проверить artifact и связать его с commit/workflow |
| REL-004 | P1 | blocked | SBOM для release artifacts | REL-001 | SBOM публикуется вместе с release и соответствует lockfile/binary build |
| REL-005 | P2 | blocked | Homebrew distribution | REL-003 | Formula проверяет checksum и устанавливает один executable |
| REL-006 | P2 | blocked | Scoop/Windows channel | REL-003 | Manifest проверяет checksum и устанавливает Windows executable |
| REL-007 | P1 | blocked | Release compatibility gate | AP-013, INT-014, REL-001 | Release блокируется при protocol, skill drift, security eval или package-content regression |

## Later

| ID | P | Статус | Задача | Зависит от | Acceptance criteria |
|---|---|---|---|---|---|
| LTR-001 | P3 | research | Несколько credential profiles | SEC-004 | Profile selection не раскрывает PAT и однозначно связывается с policy/workspace |
| LTR-002 | P3 | research | OAuth | LTR-001 | Отдельный threat model, secure refresh-token storage и revocation workflow |
| LTR-003 | P3 | research | Events/watch и read cache | AP-013 | Cache bounded, invalidation documented, content защищён restrictive permissions |
| LTR-004 | P3 | research | Attachment upload | SEC-004, DEV-010 | Отдельный threat model для path access, MIME, size и data exfiltration |
| LTR-005 | P3 | blocked | Enterprise managed policies | SEC-004, REL-003 | Policy bundle подписан, валидируется и не может ослабляться project config без явного override |

## Definition of Done для любой задачи

- Реализация не расширяет agent access к `auth`, `api call`, `request` или произвольным файлам.
- Новые argv/env/file/API/store границы имеют Zod validation.
- В `src`, `tests` и `scripts` не добавлен явный `any`.
- Добавлены positive, negative и security-relevant tests пропорционально риску.
- Ошибки не сериализуют raw SDK/HTTP objects, headers, stacks или credentials.
- Пользовательская документация и machine help обновлены вместе с поведением.
- `bun run check` проходит на поддерживаемой версии Bun.
