# asana-cli

`asana-cli` — один исполняемый файл для работы с Asana из терминала, Codex CLI и Claude Code.

Внутри используется официальный [`Asana/node-asana`](https://github.com/Asana/node-asana) 3.1.12. CLI предоставляет:

- удобные команды для пользователя, workspace, своих задач, комментариев, обновлений и поиска Git-ссылок;
- универсальный вызов всех публичных методов `*Api` из `node-asana` с тем же порядком аргументов, что в документации;
- raw REST escape hatch для новых эндпоинтов;
- безопасный прямой CLI-контракт `asana-cli agent ...` для Codex CLI и Claude Code — без MCP;
- локальное хранение PAT в системном credential manager;
- standalone-сборку через Bun: для запуска готового бинарника Bun и Node.js не нужны.

Внешние JSON-границы валидируются Zod: stdin/файлы, agent actions, raw REST payloads,
типизированные Asana DTO, environment-настройки и результаты credential manager. Универсальная
поверхность `node-asana` изолирована как `unknown` внутри SDK-адаптера и не распространяет `any`
по приложению.
> **Статус release (2026-07-15).** Последний опубликованный GitHub Release — `v0.2.0`.
> `main` уже объявляет версию `0.4.0`, однако tag `v0.4.0` и опубликованный release отсутствуют.
> Это код-кандидат на `main`, а не доступный пользователям релиз: не выдавайте его за stable и не
> устанавливайте как release binary до прохождения [release procedure](docs/implementation-plan.md#maintainer-release-procedure).

## Установка

### Готовый бинарник

Скачайте файл для своей платформы из [GitHub Releases](https://github.com/ggkguelensan/asana-cli/releases), переименуйте его в `asana-cli` и добавьте в `PATH`.

На macOS/Linux:

```sh
chmod +x asana-cli
sudo mv asana-cli /usr/local/bin/asana-cli
asana-cli --version
```

### Сборка из исходников

Нужен Bun 1.3.14:

```sh
git clone git@github.com:ggkguelensan/asana-cli.git
cd asana-cli
bun install --frozen-lockfile
bun run check
```

Результат: `dist/asana-cli` — самостоятельный нативный executable.
Для состояния release и действий maintainer перед созданием tag см. [release procedure](docs/implementation-plan.md#maintainer-release-procedure).

## PAT и `asana-cli auth pat`

Создание, просмотр списка, reset и revoke PAT выполняются в [Asana Developer Console](https://app.asana.com/0/my-apps). Asana не предоставляет PAT-management API для этого CLI.

На рабочей машине рекомендуется хранить PAT в credential manager ОС:

```sh
asana-cli auth pat set
asana-cli auth pat status
asana-cli auth pat delete
```

`set` скрывает ввод, проверяет токен через `UsersApi.getUser("me")`, затем сохраняет его в:

- macOS Keychain;
- Linux Secret Service (`libsecret`, работающий keyring/DBus обязателен);
- Windows Credential Manager.

Функция основана на экспериментальном `Bun.secrets`. Если credential manager недоступен, используйте окружение. Для CI рекомендуемое имя — `ASANA_ACCESS_TOKEN`; `ASANA_PAT` поддерживается как alias:

```sh
read -s ASANA_ACCESS_TOKEN
export ASANA_ACCESS_TOKEN
asana-cli auth status
```

Приоритет: `ASANA_ACCESS_TOKEN` → `ASANA_PAT` → credential manager.

CLI никогда не принимает `--token`, `--pat`, `--password` или PAT как позиционный аргумент. Скомпилированный binary не загружает `.env`, `bunfig.toml`, `tsconfig.json` или `package.json` из текущего каталога.

## Основные команды

```sh
# Аккаунт
asana-cli me
asana-cli workspaces --all

# Мои незавершённые задачи во всех workspace
asana-cli tasks mine --all

# Один workspace, максимум 100 задач
asana-cli tasks mine --workspace 1200123456789 --all --max-results 100

# Детали и комментарии
asana-cli task get 1200123456789
asana-cli task comments 1200123456789 --all
asana-cli task stories 1200123456789 --all

# Обновление и комментарий
asana-cli task update 1200123456789 --completed=true --due-on 2026-07-31
asana-cli task update 1200123456789 --data '{"custom_fields":{"1200":"PR-418"}}'
asana-cli task comment 1200123456789 "Исправлено в PR #418"

# Preview без записи
asana-cli task update 1200123456789 --name "Новое имя" --dry-run
asana-cli task comment 1200123456789 "Текст" --dry-run
```

JSON/text options принимают literal, `@file` или `-` для stdin.

## Поиск задач по Git-номерам

```sh
asana-cli task search-git 'owner/repo#418' --workspace 1200123456789
asana-cli task find-git 'PR-418' --field 1200999888777
asana-cli task find-git 'abc123def' --contains
```

Алгоритм:

1. Asana full-text search по имени и описанию.
2. Если указан `--field` или `ASANA_GIT_FIELD_GID` — отдельный поиск по custom field.
3. Объединение по task GID и локальная проверка token-boundary; `--contains` включает частичное совпадение.
4. При HTTP 402 от Premium search — fallback: сканирование доступных задач текущего пользователя.

Важно: Asana search не ищет в комментариях, индекс обновляется не мгновенно и возвращает максимум 100 результатов. Для Asana Custom ID используйте точный endpoint:

```sh
asana-cli task get-custom-id EX-418 --workspace 1200123456789
```

## Все методы `node-asana`

```sh
asana-cli api list
asana-cli api list TasksApi
asana-cli api docs TasksApi getTask

asana-cli api call TasksApi getTask \
  --args '["1200123456789", {"opt_fields":"name,notes,custom_fields"}]'

asana-cli api call TasksApi updateTask \
  --args '[{"data":{"completed":true}}, "1200123456789", {}]'
```

`--args` — JSON-массив позиционных аргументов строго в порядке официальной документации. Для multipart upload поддерживается file reference:

```sh
asana-cli api call AttachmentsApi createAttachmentForObject \
  --args '[{"parent":"1200123456789","file":{"$file":"./report.pdf"}}]'
```

Методы `*WithHttpInfo` намеренно скрыты: их transport/request objects могут содержать credential и не являются обычной публичной поверхностью документации.

## Raw REST

```sh
asana-cli request GET /users/me --query '{"opt_fields":"gid,name,email"}'
asana-cli request PUT /tasks/1200123456789 \
  --data '{"data":{"completed":true}}'
```

Разрешены только относительные пути `/...` на фиксированном origin `https://app.asana.com/api/1.0`; абсолютные URL и redirects запрещены.

## Portable skill integrations

`asana-cli` embeds one static portable `asana` skill bundle. It can install that bundle into
Generic Agent Skills, Codex, or Claude Code without MCP, client settings, marketplace registration,
or repository instructions.

Every target requires an explicit client and `user` or `project` scope. Inspect first; a dry run
prints the complete managed-file plan, including target paths and hashes:

```sh
asana-cli integrations list
asana-cli integrations detect --client generic-agent-skills --scope user
asana-cli integrations install --client codex --scope project --dry-run
```

Apply only after reviewing the matching plan:

```sh
asana-cli integrations install --client codex --scope project --apply
```

`install`, `update`, and `uninstall` require exactly one of `--dry-run` or `--apply`. The manager
uses a manifest and SHA-256 hashes for every managed artifact, stages changes atomically, and refuses
unmanaged, modified, malformed, or unsafe targets. `status`, `diff`, and `doctor` are local
read-only checks; `doctor` reports only inherited credential variable names, never their values.

The only managed paths are the client discovery roots (`.agents/skills/asana` for Generic Agent
Skills and Codex, or `.claude/skills/asana` for Claude Code) plus their ownership manifest. Integrations never
edit `AGENTS.md`, `CLAUDE.md`, settings, hooks, MCP configuration, marketplace entries, or the CLI
binary. Use `asana-cli integrations policy CLIENT` for display-only narrow policy guidance.

## Codex CLI и Claude Code: прямое использование

MCP здесь не используется. Агентам предназначена только curated-поверхность `asana-cli agent ...`:

```sh
asana-cli agent capabilities
asana-cli agent status

asana-cli agent my-tasks --max-results 20

asana-cli agent get-task --task 1200123456789

asana-cli agent get-task --task 1200123456789 \
  --include notes --include custom_fields --max-content-bytes 12000

asana-cli agent list-comments --task 1200123456789 \
  --max-results 50 --max-content-bytes 12000

asana-cli agent find-git --query PR-418 --field 1200999888777
```

Read-команды принимают обычные строгие flags; совместимый программный режим принимает
ровно один JSON-object через `--input -`. Эти режимы нельзя смешивать. `--include`
явно выбирает дополнительные поля задачи, а `--max-content-bytes` задаёт общий UTF-8
budget для task/comment content (по умолчанию 16 KiB, максимум 64 KiB). Превышение
отражается в `content_budget`; это ограничение размера, не sanitizer. `api call`,
`request`, file references и произвольные поля не входят в agent contract.

Запись разделена на prepare/apply:

```sh
# 1. Ничего не изменяет; сохраняет payload в локальный journal и возвращает operation_id
printf '%s' '{"task_gid":"1200123456789","patch":{"completed":true}}' |
  asana-cli agent prepare-task-update --input -

# Для комментария доступны безопасные прямые flags
asana-cli agent prepare-comment --task 1200123456789 --text 'Готово в PR-418'

# 2. После внешнего подтверждения передайте только UUID из operation_id
ASANA_CLI_AGENT_POLICY=read-write \
  asana-cli agent apply --operation-id 00000000-0000-4000-8000-000000000000
```

Устаревшие `agent apply-task-update` и `agent apply-comment` удалены: полный plan нельзя
безопасно повторно проиграть. Вместо переноса старого payload создайте новую операцию через
`prepare-task-update` или `prepare-comment`, проверьте preview и после подтверждения вызовите
`agent apply --operation-id UUID`. Отказ возвращает machine-readable details:

```json
{
  "reason": "legacy-plan-apply-removed",
  "replacement_action": "apply",
  "required_input": { "operation_id": "UUID" }
}
```

Та же migration information (включая полную replacement-команду) публикуется в
`asana-cli agent capabilities` → `deprecated_commands`. Это изменение не затрагивает совместимый
v0.2 read-ввод: через `--input -` по-прежнему принимается ровно один strict JSON object.

Совместимость direct client публикуется до вызова action. Прочитайте `asana-cli agent capabilities` (или `agent schema`) и сравните версию клиента с включительным диапазоном `protocol_compatibility.minimum` / `maximum`. Если протокол не поддержан, `unsupported_protocol` возвращает machine-readable причину, поддерживаемый диапазон и действие `upgrade-client`.

Этот диапазон описывает agent contract и не связан с `minimum_cli_version` action descriptor: последний указывает только минимальную версию executable, впервые предоставившую action.

Обе prepare-команды создают durable record с TTL, immutable payload и guard по
`modified_at`/текущему пользователю. `apply` никогда не принимает payload повторно. Agent writes
разрешены только для задач, назначенных текущему пользователю, и изменяют одну задачу за invocation.
Повторный apply состояния `applied`, `applying` или `unknown` не отправляет второй API request.
После `unknown-result` команду нельзя повторять автоматически: запись могла дойти до Asana.

`ASANA_CLI_AGENT_POLICY=read-write` — защита от случайного запуска, но не авторизация: агент технически способен сформировать environment сам. Настоящая граница записи — permission/approval policy Codex или Claude. Не разрешайте общую маску `asana-cli *`; auto-allow должен охватывать только конкретные read/prepare-команды, а `agent apply` должен всегда спрашивать человека.

Full integration and direct-protocol guidance: [docs/agent-clients.md](docs/agent-clients.md). Threat model: [SECURITY.md](SECURITY.md).

## Формат вывода и exit codes

Обычные команды печатают pretty JSON; `--compact` включает одну строку. Agent contract всегда возвращает envelope со `schema`, `content_trust`, operation/effect и security metadata.

```text
0  success
1  internal/network error without HTTP status
2  usage, validation, or local policy error
3  missing/invalid credentials or Asana 401/403
4  other Asana API error or optimistic concurrency conflict
130 interrupted hidden input
```

## Разработка

```sh
bun run dev --help
bun run typecheck
bun test
bun run build
bun run check
```

`bun run typecheck` запускает строгий TypeScript и отдельный guard, запрещающий явные `any`
в `src`, `tests` и `scripts`.

## Планирование

- [Roadmap](docs/roadmap.md) — целевая архитектура, milestones и критерии выхода.
- [Backlog](docs/backlog.md) — приоритеты, зависимости и acceptance criteria.
- [Implementation plan](docs/implementation-plan.md) — порядок ближайших PR для `v0.3` и `v0.4`.
- [Maintainer release procedure](docs/implementation-plan.md#maintainer-release-procedure) — evidence, tag и проверка публикации `v0.4`.
- [Swarm execution plan](docs/swarm-plan.md) — роли Terra/Sol/Luna, fanout waves и quality gates.

## License

MIT
