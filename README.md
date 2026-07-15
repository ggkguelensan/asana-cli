# asana-cli

`asana-cli` — один исполняемый файл для работы с Asana из терминала, Codex CLI и Claude Code.

Внутри используется официальный [`Asana/node-asana`](https://github.com/Asana/node-asana) 3.1.12. CLI предоставляет:

- удобные команды для пользователя, workspace, своих задач, комментариев, обновлений и поиска Git-ссылок;
- универсальный вызов всех публичных методов `*Api` из `node-asana` с тем же порядком аргументов, что в документации;
- raw REST escape hatch для новых эндпоинтов;
- безопасный прямой CLI-контракт `asana-cli agent ...` для Codex CLI и Claude Code — без MCP;
- локальное хранение PAT в системном credential manager;
- standalone-сборку через Bun: для запуска готового бинарника Bun и Node.js не нужны.

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

## Codex CLI и Claude Code: прямое использование

MCP здесь не используется. Агентам предназначена только curated-поверхность `asana-cli agent ...`:

```sh
asana-cli agent capabilities
asana-cli agent status

printf '%s' '{"max_results":20}' |
  asana-cli agent my-tasks --input -

printf '%s' '{"task_gid":"1200123456789","include_content":false}' |
  asana-cli agent get-task --input -

printf '%s' '{"task_gid":"1200123456789","max_results":50}' |
  asana-cli agent list-comments --input -

printf '%s' '{"query":"PR-418","field_gid":"1200999888777"}' |
  asana-cli agent find-git --input -
```

Agent-команды принимают ровно один JSON-object через stdin, имеют строгие schemas, лимиты и возвращают один JSON-object. `api call`, `request`, file references и произвольные поля не входят в agent contract.

Запись разделена на prepare/apply:

```sh
# 1. Ничего не изменяет; возвращает target, changes, modified_at guard и hash
printf '%s' '{"task_gid":"1200123456789","patch":{"completed":true}}' |
  asana-cli agent prepare-task-update --input -

# 2. После внешнего подтверждения в Codex/Claude передайте plan без изменений
printf '%s' '{"plan":{...}}' |
  ASANA_CLI_AGENT_POLICY=read-write asana-cli agent apply-task-update --input -
```

Аналогично: `prepare-comment` → `apply-comment`. Agent writes разрешены только для задач, назначенных текущему пользователю, используют optimistic concurrency guard и изменяют одну задачу за invocation.

`ASANA_CLI_AGENT_POLICY=read-write` — защита от случайного запуска, но не авторизация: агент технически способен сформировать environment сам. Настоящая граница записи — permission/approval policy Codex или Claude. Не разрешайте общую маску `asana-cli *`; auto-allow должен охватывать только конкретные read/prepare-команды, а `apply-*` должен всегда спрашивать человека.

Полная инструкция: [docs/agent-clients.md](docs/agent-clients.md). Threat model: [SECURITY.md](SECURITY.md).

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

## License

MIT
