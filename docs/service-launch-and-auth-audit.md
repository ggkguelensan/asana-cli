# Аудит топологии: поставка, запуск core и вход в Asana

Дата: 2026-11-03. Source baseline: `92d1a3b`. Решения ниже уточняют target architecture;
реализованные возможности отделены от проектируемых. PAT остаётся способом подключения Asana
в первом локальном выпуске. Авторитетный контракт запуска/auth находится в этом документе;
остальные service documents ссылаются на него.

Результат следующего implementation slice: [next watcher](next-local-tracking.md) замыкает
start → PAT verification → browser session → реальная доска → stop. Ниже сохранён аудит
исходного baseline и полный целевой контракт, включая пока отсутствующий web PAT setup.

## 1. Что аудит обнаружил в baseline

| Приоритет | Наблюдение в текущем source | Что требуется |
| --- | --- | --- |
| P0: product blocker | `apps/web/src/api/client.ts` сразу запрашивает `/api/v1/board`; UI показывает unauthorized, но входа/подключения нет. Сервер ещё отсутствует | Сначала замкнуть человеческий vertical slice: start → browser session → PAT connection → board → stop |
| P1 | `apps/cli/src/pat-store.ts` владеет credential manager; будущее ядро не может использовать его без зависимости от приложения | Выделить credential module вместе с первым runtime; CLI auth и runtime используют одну реализацию, один store key и account identity |
| P1 | `packages/asana-client` предоставляет динамический `invoke(...unknown[])`; SDK collection и pagination остаются в CLI | Это SDK dispatch adapter, а не готовый domain port. Перед domain extraction определить typed Asana operations и скрыть SDK collections/HTTP errors внутри адаптера |
| P1 | Предложенные `apps/service` и `packages/core` не задают один composition root и поставляемый executable | Зафиксировать один Bun runtime в общем package, один физический binary с режимом `service run`; Electron/плагины используют тот же binary |
| P1 | Плагины описаны как attach-only; автоматический запуск не имеет явной модели разрешения и конкуренции | Один launcher, explicit start и opt-in ensure; single-instance handshake, manual-stop latch, никакого старта из обычного read tool |
| P1 | Source-separated packages ещё не дают общую command execution authority: прямой CLI уже пишет в Asana | Новые workflow mutations проходят через core; при неоднозначном ответе запрещён fallback на direct SDK. Legacy developer API сохраняет явно отдельную семантику |
| P2 | Нет обязательной проверки отсутствия JS; проверка unsafe types обходила TSX | Введены source language gate и общий Git inventory для TS/TSX; `allowJs: false` наследуется web из общей конфигурации |
| P2 | Desktop extension, native plugin, prompt и приложение смешиваются со способом поставки сервера | Разделить runtime artifact, client integration package и host capability; qualification каждого пути отдельная |

Первые шесть пунктов — следующие implementation requirements, не утверждение об уже работающем
сервере. Сейчас реально доступны CLI/PAT, frontend/demo, общие wire schemas и SDK dispatch adapter.
В Git уже нет `.js`, `.jsx`, `.mjs`, `.cjs` project sources; новый gate предотвращает их появление.
Зависимости и генерируемый Vite/Electron browser bundle содержат JavaScript: браузер исполняет
скомпилированный JS. Авторские исходники, конфигурация и будущий Electron main/preload — TS/TSX.
Generated JS не версионируется и не редактируется вручную.

## 2. Один продукт, несколько точек входа

Основная поставка первого локального выпуска: подписанный/проверяемый standalone
`asana-cli` для поддерживаемого macOS/Linux target. Он содержит Bun runtime, Hono server,
reviewed migrations и web assets после реализации embedding. Пользователю не нужны Bun,
Node, Drizzle Kit, исходники или AI-клиент. Electron — дополнительная поставка того же core.

```text
Baseline до next watcher
terminal → apps/cli → credentials + CLI operations → SDK adapter → Asana
browser  → apps/web → HTTP/WS contract → [сервер пока не реализован]

Целевая реализация
terminal / desktop launcher / authorized plugin startup
                   │
                   ▼
            один local launcher
                   │ discover / start / handshake
                   ▼
       asana-cli service run (detached Bun process)
                   │
             local runtime
          ┌────────┼──────────┐
        Hono      core     SQLite/Drizzle
          │        │             + existing journal adapter
          │   Asana domain adapter → node-asana → Asana
          │        │
          │   credential provider → OS secret store
          │
     React web / CLI client / stdio MCP bridge
```

Один экземпляр на пользователя ОС и выбранный account profile, а не на Git repository,
плагин, вкладку или AI-сессию. В первой версии один активный Asana account. Prompt/repository
не определяет расположение БД или credentials. Electron и stdio bridge не становятся вторым
владельцем state и не открывают service SQLite для записи.

## 3. Целевые modules/packages

Это план extraction при реализации vertical slice; пустые packages сейчас не создаются.

```text
apps/
├── cli/                     существующий shell adapter и физический executable entrypoint
├── web/                     существующий React/Jotai browser client
└── desktop/                 будущая Electron оболочка, main/preload на TS
packages/
├── contracts/               существующие public wire schemas; добавить bootstrap/status/auth DTO
├── asana-client/            существующий SDK adapter; углубить typed domain operations
├── core/                    будущие deterministic commands, revisions и workflow rules
├── local-runtime/           будущий Bun composition root: Hono, lifecycle, discovery, storage
├── credentials/             будущая общая реализация PAT connection/store для CLI и runtime
└── service-client/          будущий browser-safe HTTP/WS client из текущего web adapter
```

`core` зависит от domain ports, не от Bun/Hono/Drizzle/generated SDK classes. Runtime связывает
ports с реальными adapters. SQLite/Drizzle, migrations и launch/discovery initially могут быть
внутренними modules `local-runtime`: отдельный package нужен при реальном повторном использовании.
Клиенты не импортируют storage, credentials или executable bootstrap.

Не нужен независимо развиваемый `apps/service` с отдельной копией configuration и отдельной
release matrix. Для supervisor `asana-cli service run` вызывает тот же runtime entrypoint.
Отдельный executable можно добавить позже, если появится обоснованная поставка; он обязан
использовать тот же composition root, discovery и instance identity.

Electron main работает в Node. Он **не импортирует** Bun-only modules (`bun:sqlite`, `Bun.secrets`)
и не пересобирает core под Electron Node. Он вызывает bundled/installed Bun-compiled binary как
sidecar, затем подключает renderer к тому же HTTP/WS service. Native shell открывает board через
локальный session bootstrap; renderer с `nodeIntegration: false`, `contextIsolation: true`, узкий
preload interface и ограниченная навигация. Проверка конкретного Electron packaging/signing пути
остаётся отдельным deliverable.

## 4. Три независимые авторизации

| Уровень | Что разрешает | Где secret |
| --- | --- | --- |
| Asana PAT | Доступ к Asana от конкретного пользователя | OS credential store на core host; токен в памяти SDK только во время работы |
| Сессия нашего UI/CLI/MCP | Обращение к локальному сервису и его разрешённым effects | Browser HttpOnly cookie либо scoped native client credential; это не PAT |
| Remote pairing / MCP OAuth | Подключение удалённого клиента к конкретному устройству | Отдельные от PAT credentials; gateway не получает Asana PAT |

Asana permissions в целевом default соответствуют правам пользователя API: tracking и
self-assignment не являются allowlist. Разрешение управлять runtime/credentials — отдельный
effect, а не скрытое ограничение Asana mutations. Legacy agent read policy нельзя переносить
как default нового human core; это отдельная миграция SVC-010.

Сессия пользователя на asana.com не авторизует наш localhost. Пароль Asana наш UI не принимает.
PAT нельзя получить автоматически из browser cookie. Авторизация в Claude/Codex тоже не является
авторизацией в нашем core или в Asana.

### Уже настроен PAT через CLI

1. Пользователь выполняет существующее `asana-cli auth pat set` с hidden input.
2. Будущий `asana-cli board open` явно запускает/находит core и открывает browser bootstrap.
3. Core использует тот же credential store, проверяет Asana account и отдаёт connection status.
4. Web показывает подключённого пользователя и workspaces. Повторно вводить PAT не требуется.

Текущий `auth pat set` сохраняет PAT; описанная здесь runtime verification и board launch ещё
не реализованы. Не выдаём эту последовательность за доступный сегодня end-to-end flow.

### PAT ещё нет: вход через локальную веб-морду

Кнопка должна называться **«Подключить Asana по PAT»**, а не «Войти через Asana».

1. Launcher открывает owner-authorized setup page на loopback origin. У обычной неавторизованной
   вкладки нет права назначить credential или захватить первый account.
2. Страница даёт ссылку на Asana developer console и одноразовое password input для PAT.
3. Браузер отправляет PAT ровно один раз в body owner-only local credential endpoint.
4. Runtime проверяет token через Asana identity request; при успехе сохраняет в OS secret store.
   Сетевой сбой или ошибка проверки не перезаписывают рабочий credential. Locked/unavailable
   credential store выдаёт отдельный recoverable state; plaintext file fallback не создаётся.
5. Input очищается; PAT не входит в Jotai board state, localStorage, IndexedDB, URL, logs,
   analytics, command journal, WS stream или ответы сервера. Запрос credential setup имеет
   отдельную redaction policy на входе до generic request/error logging.
6. В UI остаются account/workspace, source of credential и безопасный status; readback PAT отсутствует.

Это уточняет прежнее слишком широкое «PAT никогда не попадает в браузер»: при вводе PAT в GUI
он неизбежно кратковременно присутствует в форме и request body. Постоянно PAT принадлежит core;
браузерная доска никогда не использует его для прямых Asana requests. Очищение поля не является
гарантией стирания памяти браузера. Эта форма доступна только локально и owner-session; remote
board/gateway не принимает PAT. Electron setup использует такую же локальную connection operation.

Для настоящей кнопки **«Войти через Asana»** нужен отдельный Asana OAuth application и проверенный
authorization-code flow. Это возможный следующий способ подключения для широкой публичной
поставки; он не заменяет выбранный PAT flow молча. OAuth нашего gateway — отдельный протокол.

### Bootstrap браузерной сессии

`board open` получает короткоживущий одноразовый nonce, открывает его непосредственно через
OS browser opener и обменивает на HttpOnly/SameSite session cookie на том же origin. Bootstrap
nonce не является PAT, не печатается в agent-visible tool output, не пишется в discovery/logs;
TTL, single use и exact Origin/Host проверяются сервером. Если nonce передаётся во fragment,
страница убирает его через history replacement до подключения основной доски. Cookies используют
Secure при HTTPS; loopback HTTP является отдельным local transport mode.

POST/WS проверяют session, Origin и разрешённый effect; cookie mutations также CSRF. Local
control credential не отправляется renderer. Ошибка service auth ведёт к повторному bootstrap;
ошибка Asana PAT ведёт в connection setup, сохраняя вход в локальный UI. Эти состояния нельзя
склеивать в один `unauthorized`. Bootstrap/connection status должны работать без board snapshot:
`csrf_token` в нынешнем snapshot не заменяет полноценный session/auth contract.

## 5. Как пользователь запускает продукт

Ниже целевой UX, команды `setup`, `board`, `service`, `mcp` ещё проектируются:

```sh
# Первый запуск standalone поставки:
asana-cli setup
# Устанавливает connection через local setup, находит/запускает core, открывает доску.

# Обычный явный запуск / открытие:
asana-cli board open
asana-cli service status
asana-cli service stop

# Supervisor или диагностика foreground:
asana-cli service run

# Attach-only MCP bridge (default):
asana-cli mcp serve
# Опциональный запуск core, только после явной настройки пользователем:
asana-cli mcp serve --ensure-service
```

`setup` не устанавливает глобальные AI configs или autostart без выбора пользователя.
`board open` и `service start` — явные human launch actions. Agent read/mutation/tool discovery
сами не устанавливают executable, не меняют PAT и не запускают core. Launcher возвращает
структурированные `service_not_running`, `start_disabled`, `incompatible_version`,
`credential_required`/`credential_store_locked`/`asana_unavailable`, а не предлагает агенту
догадываться по stdout. Shell prompt не является механизмом supervision.

### Матрица поставки и запуска

Все новые service/plugin/Electron routes planned; direct CLI и frontend development уже доступны.

| Точка входа / поставка | Кто запускает core | Что пользователь устанавливает | Когда core продолжает работать |
| --- | --- | --- | --- |
| Репозиторий с промптом | Человек запускает source launcher; local agent может выполнить ту же явную команду с разрешением host | Checkout + Bun из packageManager + frozen root install | После завершения агента; detached процесс не зависит от его terminal pipes |
| `asana-cli` utility | `setup`/`board open`/`service start` через общий launcher | Standalone binary; package manager wrapper позднее квалифицируется отдельно | Пока не выбран stop; после logout/reboot только с opt-in OS autostart |
| Codex CLI | Человек либо local stdio bridge с явно включённым ensure | Наш binary + skills/native plugin или ручная MCP registration | Закрытие Codex завершает только bridge |
| Claude Code CLI | То же через local MCP/plugin; static launch args | Наш binary + native plugin/skills/MCP registration | Закрытие Claude Code завершает только bridge |
| Codex Desktop local executor | Поддержанный local tool/MCP запускает наш binary после host trust/authorization | Native plugin + установленный binary или квалифицированный bundled binary | Core независим от app session; cloud executor не запускает ноутбук |
| Claude Desktop local extension | MCPB binary entry запускает bridge; ensure opt-in либо предварительный manual setup | Desktop extension + runtime binary, bundled после отдельной packaging qualification | Закрытие Desktop не означает service stop |
| Electron application | Main вызывает тот же compiled binary sidecar через explicit launcher | Подписанное приложение с target-specific binary и web assets | Закрытие окна не стопает core; «Остановить сервис» вызывает общий handler |
| Hosted browser / remote MCP / mobile | Ни prompt, ни удалённый plugin не могут сами запустить выключенный/недоступный host | Remote connection + заранее работающий paired core либо явно выбранный always-on host | Нужен работающий authority host; gateway не заменяет его |

Репозиторий/промпт и plugin — не самостоятельные runtimes. При запуске агента в cloud/SSH core
появится на том host, где выполнена команда, а `127.0.0.1` будет относиться к нему. Наш launcher
не должен подменять local host cloud executor-ом. Исходная dev-команда `bun run dev` сейчас
поднимает только Vite. Она не запускает core; полный dev orchestration добавляется вместе с ним.

### Lifecycle invariants

- `ensure` использует owner-controlled discovery и authenticated handshake, atomic single-instance
  lock и ready timeout. Конкурентный запуск CLI/двух plugins/Electron создаёт один core.
- Известный совместимый экземпляр переиспользуется независимо от того, какой package принёс
  binary. Несовместимость не вызывает скрытый upgrade/restart во время mutation.
- Explicit stop через UI/CLI ставит persistent manual-stop latch. Автоматический ensure и
  supervisor не обходят его. Явный human start/board open снимает latch; tool read этого не делает.
- Закрытие вкладки, bridge, desktop window или последнего AI conversation не останавливает core.
  Closing whole Electron app и режим background должны быть явно описаны в UX; sidecar detached.
- LaunchAgent/systemd autostart — opt-in. Обновление binary — явный coordinated drain/restart,
  с проверкой protocol/schema compatibility и без повторения unknown Asana writes.
- Daemon pin-ит credential source/account при старте. Background default — OS store. Environment
  PAT допускается в явно выбранном foreground/headless mode; plugin/desktop не наследуют его
  случайно из shell. Account mismatch не исправляется незаметным переключением account.
- Core стартует без сети и без PAT в `setup_required`/degraded, чтобы UI мог выполнить onboarding.
  Local ready и Asana connected — разные признаки. В SQLite по-прежнему workflow metadata,
  а не обязательная копия task content или credentials.

## 6. Remote/mobile и ограничения vendor surfaces

Remote MCP соединяется с gateway по HTTPS с отдельным OAuth/pairing и ограниченными capabilities.
Gateway маршрутизирует к уже доступному paired core по исходящему authenticated соединению.
Он не открывает весь local admin HTTP server и не принимает PAT. Если host offline/stopped,
клиент получает `device_offline`/`service_stopped`; cloud plugin не делает remote power-on.
Полностью автономная mobile работа требует всегда доступного authority host либо отдельного
явного переноса authority. Это другой deployment mode, а не флаг localhost.

Платформенный remote control может доставить действие на desktop host: для Codex и Claude
такие пути квалифицируются отдельно. В частности, Claude Cowork документирует доступ к local
connectors через открытое desktop приложение для определённых desktop-originated sessions;
это не запуск binary на телефоне и не делает loopback-доску доступной mobile browser.

OpenAI документирует local stdio commands и remote HTTP MCP. Публикация local MCP в публичном
plugin directory имеет отдельные partner/approval ограничения. Это не запрет ручной local MCP
registration, и не гарантия shell доступа у любого cloud/mobile conversation. Claude Desktop
поддерживает binary desktop extensions; это позволяет не вводить Node/Bun requirement для
пользователя, но конкретный compiled-binary package всё равно требует install/uninstall tests.
Electron Windows shell может быть remote client; local Windows core не входит в текущую POSIX
release matrix и потребует отдельной квалификации.

Дополнительные требования: [agent-authored views](service-extensible-views.md) используют
SDK/готовую UI library и host bridge; [GitLab](service-gitlab-integration.md) работает через
server-side adapter и общий sync. Generated HTML не получает runtime/admin credentials.

## 7. Что менять первым

1. Source gate TS/TSX и inventory исправлены в этом изменении; JS source files не найдено.
2. Этот документ фиксирует ownership/auth/launch решения и заменяет неоднозначные target paths.
3. Следующий runtime PR: один composition root + общий credential module, discovery/start/stop,
   browser bootstrap, local PAT onboarding и минимальный authenticated board. Без plugin/agent.
4. Затем domain extraction: deterministic core, SQLite/Drizzle и typed Asana port, один writer
   для workflow commands, текущий SDK escape hatch остаётся developer surface.
5. После человеческого vertical slice: общий service client и stdio MCP adapter, затем реальные
   packages для Codex/Claude. Не дублировать правила и lifecycle в host-specific hooks.
6. Electron packaging и remote gateway идут отдельно; не объявлять их работоспособными на
   основании наличия manifest, URL, prompt или прошедших CLI tests.

Обязательные новые acceptance tests: cold start без credentials; PAT setup из owner-session;
reject неавторизованного credential overwrite; credential-store locked/network failure; restart
с тем же account; новый browser bootstrap; два concurrent launchers; parent/bridge exit;
manual stop против auto-ensure; protocol mismatch; отказ hidden direct-SDK retry после timeout;
compiled binary без checkout/assets рядом; Electron sidecar без Bun/Node у пользователя.

## 8. Официальные источники, проверены 2026-11-03

- [Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model) и
  [utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process): Node runtime;
  [Bun standalone executable](https://bun.sh/docs/compiler/executables): runtime внутри binary.
- [Asana PAT](https://developers.asana.com/docs/personal-access-token): выдача в developer console;
  [Asana OAuth](https://developers.asana.com/docs/oauth): отдельный authorization-code flow.
- [OpenAI MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli): local stdio/remote HTTP;
  [desktop-only plugin submission](https://developers.openai.com/plugins/deploy/desktop-only):
  ограничения публичной поставки; [plugin hooks](https://developers.openai.com/plugins/build/plugins):
  установка не равна trust/исполнению hooks.
- [Claude local MCP](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop),
  [Claude Code MCP](https://code.claude.com/docs/en/mcp),
  [remote connector reachability](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp),
  [Cowork surfaces](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile).

Сведения о поставщиках не заменяют qualification нашего package. Решения о едином binary,
PAT onboarding и topology — проектные выводы этого аудита, не требования vendor documentation.
