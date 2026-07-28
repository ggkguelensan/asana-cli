import { CLI_VERSION } from "./version";

export const HELP = `asana-cli ${CLI_VERSION} — Asana из терминала и AI-агентов

USAGE
  asana-cli <command> [arguments] [options]

AGENT CLIENTS
  asana-cli --agents                     Первая точка входа для любого агента
  asana-cli agent-setup ...              Установить навыки глобально или в проект
  asana-cli agent capabilities           Безопасный машиночитаемый контракт

START
  asana-cli doctor                       Проверить установку, PATH, PAT и журнал
  asana-cli auth pat set                 Сохранить PAT через скрытый ввод
  asana-cli me                           Текущий пользователь
  asana-cli workspaces --all             Доступные workspace

TASKS
  asana-cli tasks mine [--all]           Мои задачи
  asana-cli task get GID                 Одна задача
  asana-cli task comments GID            Комментарии
  asana-cli task search TEXT             Поиск
  asana-cli task update GID [options]    Изменить задачу
  asana-cli task comment GID TEXT        Добавить комментарий

LEARN AND MAINTAIN
  asana-cli man [TOPIC]                  Глоссарий, примеры и гайдбуки
  asana-cli insights [--days 30]         Анализ локальной истории CLI
  asana-cli update --check               Проверить новую версию
  asana-cli update                       Безопасно обновить CLI

AUTHENTICATION
  asana-cli auth                         Инструкции
  asana-cli auth pat status              Проверить источник и валидность PAT
  asana-cli auth pat delete              Удалить локальную копию

LOCAL DEVELOPER CONTEXT
  asana-cli context quick                Текущий task/worktree context
  asana-cli context alias list           Локальные task aliases
  asana-cli context history              Недавний context

INTEGRATIONS
  asana-cli integrations list
  asana-cli integrations status --client CLIENT --scope user|project [--skill SKILL]
  asana-cli integrations install --client CLIENT --scope user|project --dry-run|--apply

NODE-ASANA PRIMITIVES
  asana-cli api list [ApiClass]
  asana-cli api docs <ApiClass> [method]
  asana-cli api call <ApiClass> <method> --args '<JSON array>'

RAW REST API
  asana-cli request <GET|POST|PUT|PATCH|DELETE> </path> [--data '<JSON>']

COMMON OPTIONS
  --workspace GID   --fields CSV   --all   --max-results N   --compact
  --help, -h        --version, -V

Подробности: asana-cli man
Перед первой сетевой командой: asana-cli auth`;

export const AUTH_HELP = `Asana PAT setup

1. Create a Personal Access Token in Asana's developer console:
   https://app.asana.com/0/my-apps

2. Recommended for a developer workstation — encrypted OS credential storage:

     asana-cli auth pat set
     asana-cli auth pat status

   The hidden prompt never puts the token in shell history. Storage uses macOS
   Keychain or Linux Secret Service.

3. Recommended for CI and ephemeral shells — process environment (higher priority).
   Use ASANA_ACCESS_TOKEN; the TOKEN suffix is recognized by agent environment filters.

   For the current shell without putting the token in shell history:
     read -s ASANA_ACCESS_TOKEN
     export ASANA_ACCESS_TOKEN

   For a CI secret:
     configure ASANA_ACCESS_TOKEN in your CI secret store and expose it only to the job.

4. Verify without revealing the token:
     asana-cli auth status
     asana-cli me

Compatibility alias: ASANA_PAT.

Security notes:
  - Never commit PATs or .env files.
  - Never pass a PAT as a command-line argument; process arguments may be visible.
  - Rotate the PAT immediately if it is exposed.
  - asana-cli never prints the token and intentionally does not load .env files.

Creating, reviewing, resetting, and revoking PATs is done in Asana's developer
console. 'auth pat' manages only this machine's encrypted local copy.`;

export const PAT_HELP = `Manage this machine's Asana PAT

  asana-cli auth pat set                 Hidden interactive prompt
  printf '%s' "$ASANA_ACCESS_TOKEN" | asana-cli auth pat set --stdin
  asana-cli auth pat set --from-env      Copy env PAT into OS credential storage
  asana-cli auth pat status              Validate the active PAT without printing it
  asana-cli auth pat delete              Delete only the OS-stored PAT

Credential precedence:
  ASANA_ACCESS_TOKEN -> ASANA_PAT -> OS credential storage

PAT creation and revocation remain in Asana Developer Console:
  https://app.asana.com/0/my-apps`;
