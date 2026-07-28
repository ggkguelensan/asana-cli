# asana-cli

Один CLI для работы с Asana из терминала и AI-агентов. Работает на macOS и Linux.

## Зачем

- читать, искать и изменять задачи без браузера;
- использовать всю Asana API через официальный `node-asana` и raw REST;
- безопасно подключать Codex, Claude Code и другие агенты без MCP;
- хранить PAT в credential manager ОС;
- видеть локальную историю команд и получать практические insights;
- устанавливать и обновлять один standalone binary — Bun/Node для него не нужны.

## Скачать

Готовый binary с проверкой SHA-256:

```sh
curl -fsSL https://raw.githubusercontent.com/ggkguelensan/asana-cli/main/install.sh | sh
```

По умолчанию он устанавливается в `~/.local/bin`. Скрипт можно сначала скачать и прочитать:

```sh
curl -fLO https://raw.githubusercontent.com/ggkguelensan/asana-cli/main/install.sh
sh install.sh --help
sh install.sh --version 1.0.1 --bin-dir "$HOME/.local/bin"
```

Через Bun:

```sh
bun add --global github:ggkguelensan/asana-cli
```

Или скачайте binary и `SHA256SUMS` вручную из
[GitHub Releases](https://github.com/ggkguelensan/asana-cli/releases).

## Начать работать

```sh
asana-cli doctor
asana-cli auth pat set
asana-cli auth pat status

asana-cli me
asana-cli workspaces --all
asana-cli tasks mine --all --max-results 100
```

PAT создаётся в [Asana Developer Console](https://app.asana.com/0/my-apps). CLI принимает его
только через скрытый ввод, credential manager или `ASANA_ACCESS_TOKEN`; он не принимает секрет
как аргумент и не печатает его.

Примеры:

```sh
asana-cli task get TASK_GID
asana-cli task comments TASK_GID --all
asana-cli task search-git 'owner/repo#418' --workspace WORKSPACE_GID

asana-cli task update TASK_GID --completed=true --dry-run
asana-cli task update TASK_GID --completed=true
asana-cli task comment TASK_GID "Исправлено в PR #418"
```

## Для агента

Первая точка входа:

```sh
asana-cli --agents
```

Она возвращает clients, scopes, правила безопасности и четыре встроенных навыка:

- использование `asana-cli`;
- устройство и глоссарий Asana;
- read-only изучение процессов Asana конкретной компании;
- анализ локальной истории `asana-cli`.

Установка всех навыков только для проекта:

```sh
asana-cli agent-setup --client codex --scope project --dry-run
asana-cli agent-setup --client codex --scope project --apply
```

Для глобальной установки используйте `--scope user`. Сначала проверяйте dry-run. Установщик не
меняет `AGENTS.md`, `CLAUDE.md`, settings, hooks или MCP.

## Самостоятельно изучать

```sh
asana-cli --help
asana-cli man
asana-cli man glossary
asana-cli man examples
asana-cli man agents
asana-cli man company
```

`asana-cli man` встроен в binary и содержит глоссарий, примеры и гайдбуки. Полная техническая
документация находится в [`docs/`](docs).

## Обслуживать и анализировать

```sh
asana-cli doctor
asana-cli update --check
asana-cli update
asana-cli insights --days 30
```

CLI ведёт owner-only JSONL-журнал локальных запусков. В нём есть только категории команд,
результаты, длительность и нормализованные коды ошибок — без свободных значений аргументов, GID,
путей, содержимого задач/комментариев и PAT. Путь и состояние журнала показывает `asana-cli doctor`.

Подробности:

- [`SECURITY.md`](SECURITY.md) — модель безопасности;
- [`docs/agent-clients.md`](docs/agent-clients.md) — агентский контракт;
- [`docs/release-verification.md`](docs/release-verification.md) — проверка release;
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — разработка и проверки.

Лицензия: [MIT](LICENSE).
