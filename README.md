# asana-cli

Самостоятельный CLI для Asana на официальном [Node SDK](https://github.com/Asana/node-asana).
Работает на macOS и Linux. Все структурированные результаты возвращаются в JSON;
ошибки — в stderr с ненулевым exit code. `--compact` включает однострочный JSON.

## Сборка

```sh
bun install --frozen-lockfile
bun run build
./dist/asana-cli --help
```

Для установки собранного бинарника: `./install.sh --binary "$PWD/dist/asana-cli"`.
Поддерживаемые платформы описаны в [support-policy](docs/support-policy.md).

## Авторизация

```sh
asana-cli auth pat set
asana-cli auth pat status
asana-cli me
```

Приоритет: `ASANA_ACCESS_TOKEN` → `ASANA_PAT` → хранилище ОС.
PAT можно передать через скрытый ввод, stdin или окружение; аргумент с токеном запрещён.
Создание и отзыв PAT выполняются в Asana Developer Console.

## Задачи

```sh
asana-cli workspaces --all
asana-cli tasks mine --workspace WORKSPACE_GID --all
asana-cli task get TASK_GID
asana-cli task comments TASK_GID
asana-cli task search "release" --workspace WORKSPACE_GID --all-assignees
asana-cli task update TASK_GID --completed=true --dry-run
asana-cli task comment TASK_GID "Комментарий"
```

`task get`, `comments`, `stories`, `update` и `comment` также принимают URL задачи Asana.
`--dry-run` у update/comment возвращает тело запроса без изменения задачи.
JSON-параметры принимают литерал, `@file.json` или `-` для stdin.
Для чтения доступны `--fields`, `--all`, `--max-results`; набор флагов зависит от команды.

## SDK и REST API

```sh
asana-cli api list
asana-cli api list NotificationsApi
asana-cli api docs NotificationsApi getNotificationsForUser
asana-cli api call NotificationsApi getNotificationsForUser --args '["me","WORKSPACE_GID",{"limit":20}]'
asana-cli request GET /tasks/TASK_GID --query '{"opt_fields":"name,completed"}'
```

Все методы SDK доступны через `api call`, кроме `WithHttpInfo`, возвращающих HTTP internals.
Аргументы соответствуют порядку в SDK. Новые возможности SDK описаны в [sdk-3.4.0](docs/sdk-3.4.0.md).

## Диагностика

`asana-cli doctor` проверяет платформу, PATH и авторизацию Asana.
`doctor --offline` пропускает сетевую проверку PAT.
Встроенная справка: `asana-cli man`, `man glossary`, `man examples`, `man auth`.
CLI не устанавливает навыки или настройки внешних клиентов и не управляет Git/worktree.
Он не ведёт журнал вызовов и не обновляет себя из GitHub.

## Разработка

```sh
bun run check
```

[Архитектура](docs/architecture.md) · [Тестирование](docs/testing.md) ·
[Безопасность](SECURITY.md) · [Вклад в проект](CONTRIBUTING.md)
