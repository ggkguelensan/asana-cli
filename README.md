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

> **Статус release (2026-07-23).** Текущий опубликованный GitHub Release —
> [`v0.4.0`](https://github.com/ggkguelensan/asana-cli/releases/tag/v0.4.0), tag указывает на
> commit [`81c1b7a`](https://github.com/ggkguelensan/asana-cli/commit/81c1b7afa789527cc52faca8ca300f9f66da63f4).
> Release workflow успешно собрал семь platform binaries и `SHA256SUMS`. Версия исходников,
> embedded integration bundle и CLI остаётся `0.4.0`; изменения после tag относятся к следующему
> циклу и не являются новым release до отдельного version bump и tag.
>
> **Platform policy после `v0.4.0`:** новые releases поддерживают только native macOS и Linux.
> Windows x64 artifact в `v0.4.0` остаётся историческим и не означает дальнейшую поддержку.
> Точная матрица и исполняемый gate описаны в [platform support policy](docs/support-policy.md).

## Установка

### Готовый бинарник

Скачайте macOS или Linux файл для своей архитектуры из
[GitHub Releases](https://github.com/ggkguelensan/asana-cli/releases), переименуйте его в
`asana-cli` и добавьте в `PATH`.

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
Для зафиксированного состояния `v0.4.0` и действий maintainer перед следующим tag см.
[release record и release procedure](docs/implementation-plan.md#release-record-v040).

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
- Linux Secret Service (`libsecret`, работающий keyring/DBus обязателен).

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

# Локальный read-only контекст текущего worktree; принимается только этот flag
asana-cli agent context --git-current

# Локальное trusted сопоставление текущего worktree с Asana; PAT и сеть не нужны
asana-cli agent context --repository-asana

# Authenticated поиск кандидатов по текущему Git context; `--workspace` обязателен
asana-cli agent context --git-current-candidates --workspace 1200123456789 --completed --field 1200999888777

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

`agent context --git-current` локально и только для чтения получает нормализованную Git-идентичность текущего worktree; PAT не нужен, запросов к Asana или удалённым сервисам нет. Это не lookup кандидатов в Asana. В ответе есть только ограниченные host, owner/name репозитория, branch (или `null` в detached HEAD), полный commit и ограниченные PR/issue tokens; raw remote URL, Git config, пути, raw Git output и stderr намеренно не возвращаются. Команда принимает ровно `--git-current`: stdin и дополнительные flags не поддерживаются.

`agent context --repository-asana` — отдельный local read-only lookup: сначала получает ту же нормализованную Git identity, затем возвращает только один exact match из host-administered mapping. PAT, Asana client и сеть не используются. Конфигурация никогда не берётся из checkout, remote URL, Git config, argv, stdin или environment; этот action принимает ровно `--repository-asana`. В ответе есть только normalized `git.remote.host`, `git.repository.owner`/`name` и `mapping.workspace_gid`, а при наличии — `project_gid` и `git_reference_custom_field_gid`; branch, commit, raw remote, путь конфигурации, её содержимое, остальные mappings и filesystem/security metadata намеренно не возвращаются.

Host administrator создаёт единственный строгий JSON-файл: macOS —
`/private/etc/asana-cli/repository-asana-mapping.json`, Linux —
`/etc/asana-cli/repository-asana-mapping.json`. CLI принимает только root-owned regular file и
все directory ancestors без group/other write и без links. Минимальная schema (strict objects,
1–100 unique exact `host` + `owner` + `name` entries, без unknown keys) выглядит так:

```json
{
  "schema": "asana-cli.repository-asana-mapping.v1",
  "mappings": [
    {
      "remote": { "host": "github.com" },
      "repository": { "owner": "acme", "name": "service" },
      "workspace_gid": "1200123456789"
    }
  ]
}
```

`host` должен быть нормализованным lowercase host; `owner` и `name` match exactly. `workspace_gid` обязателен; `project_gid` и `git_reference_custom_field_gid` — optional decimal GID и при отсутствии не возвращаются. Missing file или no exact match возвращают generic `not-found`; unsafe, unreadable, oversized, malformed или schema-invalid file — generic `storage-invalid`, без путей, diagnostics или private content.

Mapping — advisory read context, не authorization: он никогда не разрешает и не запрещает write, не меняет host write policy, live task revalidation, prepare/apply либо DEV-005 candidate lookup. Для DEV-005 caller вручную передаёт `mapping.workspace_gid` как `--workspace` и, только если поле присутствует, `mapping.git_reference_custom_field_gid` как `--field`; mapping не подставляет flags автоматически, не выбирает task и не расширяет candidate scope. Это не DEV-012 repository-root versioned manifest, aliases, templates или precedence lifecycle.

`agent context --repository-context` is DEV-012's separate local read-only action. It discovers only the current Git worktree top level and reads exactly `<worktree-root>/.asana-cli/repository-context.json`; no parent search, alternate file, Git configuration, remote, branch, argv path, stdin, environment, include, overlay, script, URL, network request or fallback participates. It accepts only the bare `--repository-context` selector. It does not require, inspect or prompt for a PAT, construct an Asana client, or contact Asana or any other network service.

The manifest is repository-controlled **untrusted advisory context**, not host configuration. It is a nonempty, at-most-100-entry, strict v1 object; duplicate decoded JSON keys, unknown keys, links/reparse points, non-regular/unsafe/unreadable/empty/oversized files, invalid UTF-8/JSON, and invalid schema are rejected. Missing context (or no Git worktree) returns only generic `not-found`; every unsafe or malformed storage outcome returns only generic `storage-invalid`. Neither response discloses the worktree root, manifest path, source bytes, Git output, filesystem metadata, or diagnostics. A compact full-kind manifest is:

```json
{
  "schema": "asana-cli.repository-context.v1",
  "revision": 7,
  "workspace_gid": "1200123456789",
  "mappings": [
    { "kind": "project", "alias": "platform", "project_gid": "1200987654321" },
    { "kind": "section", "project_alias": "platform", "alias": "backlog", "section_gid": "1200111222333" },
    { "kind": "custom-field", "alias": "git-reference", "custom_field_gid": "1200222333444" },
    { "kind": "task", "project_alias": "platform", "alias": "dev-012--repository-context", "task_gid": "1200333444555" }
  ]
}
```

`workspace_gid` and every `*_gid` are immutable decimal ASCII strings; GIDs are never numeric-coerced. `revision` is a positive integer (maximum `2147483647`) reported exactly as supplied: the loader never infers, increments, caches, or claims monotonicity across checkouts. It computes a fresh `sha256:<64 lowercase hex>` semantic digest over schema, revision, workspace GID, and mappings; formatting, object-key order, mapping order, and line endings do not affect it, while a semantic change does. The digest is returned, never stored in the manifest.

Project, section, and custom-field aliases are canonical 1–63-character lowercase ASCII slugs (`a-z`, `0-9`, interior hyphens only). A task alias is a 3–96-character canonical `locator--title-slug`: `locator` is a lowercase ASCII code slug or decimal GID-shaped stable locator; `title-slug` uses the same slug grammar; there is exactly one literal `--`. Thus the response exposes each task as the immutable-GID locator `task:<project-alias>/<task-alias>`, for example `task:platform/dev-012--repository-context`. It never trims, folds case, normalizes/transliterates Unicode, decodes URLs/percent escapes, generates a slug, or accepts a bare/fuzzy alias. Project aliases and GIDs, section scopes and GIDs, custom-field aliases and GIDs, and fully qualified task locators are unique; a task and section must reference a declared project. Mapping order has no precedence, and the same task GID may intentionally occur under distinct qualified task locators.

The bounded deterministic response contains only `schema`, `revision`, `digest`, `workspace_gid`, and sorted `projects`, `sections`, `custom_fields`, and `tasks` projections. DEV-012 only reads and reports this data: it does not resolve an alias, choose a task, hand values to DEV-005, search candidates, modify a prepare/apply input, or authorize/deny a write. DEV-006 remains the distinct trusted **host-administered** remote-keyed mapping and neither source overrides, merges with, or has priority over the other. DEV-013 owns later task-reference resolution; DEV-014 owns alias lifecycle/worktree-local state; DEV-015 owns templates. Existing prepare/apply checks continue to revalidate live task state, membership, concurrency, and host policy.

Для отдельного, аутентифицированного поиска Asana-кандидатов используйте только `asana-cli agent context --git-current-candidates --workspace GID [--all-assignees] [--completed|--no-completed] [--field GID]`. `--workspace` обязателен; без `--all-assignees` поиск ограничен задачами аутентифицированного пользователя. Это только direct flags: `--input -`, `--query`, `--contains`, `--max-results`, Git values и любые другие flags отвергаются. Ответ содержит не более 20 `candidates` и `meta`: metadata задачи и структурные основания совпадения (`repository`, `branch`, `commit`, `pull-request` или `issue`; только поле `name`, `notes` или `custom-field`), без snippets, значений полей, raw Git данных или выбора target. Любые данные Asana остаются недоверенными. Empty, single, multiple и `truncated` результаты никогда не выбирают задачу: для следующего `get-task` или prepare вызова нужен явный canonical GID из возвращённого `candidate.task.gid`.

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
- [Release plan](docs/release-plan.md) — последовательный scope `v0.5` → `v1.0.0`.
- [Backlog](docs/backlog.md) — приоритеты, зависимости и acceptance criteria.
- [Implementation plan](docs/implementation-plan.md) — текущее состояние и порядок ближайших PR для `v0.5`.
- [Platform support policy](docs/support-policy.md) — поддерживаемые runtime/artifacts и executable gate.
- [Maintainer release procedure](docs/implementation-plan.md#maintainer-release-procedure) — version bump, evidence, tag и проверка следующей публикации.
- [Swarm execution plan](docs/swarm-plan.md) — история выполненных waves, роли Terra/Sol/Luna и quality gates.

## License

MIT
