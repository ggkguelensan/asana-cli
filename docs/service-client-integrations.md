# Плагины и подключения Claude / Codex

Статус: целевой дизайн, 2026-11-03. Ни один новый клиент ниже не объявляется поддержанным
этим документом. Текущая evidence-derived матрица находится в
[client compatibility](client-compatibility.md); существующий direct CLI путь — в
[agent clients](agent-clients.md). Дизайн ядра и scope релизов определены в
[target state](service-target-state.md) и [delivery plan](service-delivery-plan.md).

## 1. Одинаковый пользовательский результат

Пользователь подключает свой сервис один раз, выбирает account/workspace/device и видит ту же
доску из AI-клиента и браузера. Плагин помогает найти задачу, объяснить ожидание, обновить локальный
статус, передать работу и подготовить изменение Asana. Запись Asana подтверждается в предусмотренной
человеческой поверхности, после чего её реальный результат возвращается в разговор и на доску.

Плагин — installable package с инструкциями и декларацией доступных tools. Он не содержит PAT,
личных задач, localhost token, конкретного session ID или собственного ядра. Он не гарантирует
постоянно выполняющийся агент и не предоставляет универсальный SendMessage между приложениями.

Три самостоятельных вопроса для каждого клиента:

1. Как доставляются skills и metadata: local managed skill, native plugin или desktop extension?
2. Где исполняется tool: в локальном процессе, на подключённом host или в удалённом MCP gateway?
3. Где показывается UI: обычный browser URL либо проверенный embedded UI resource?

Успешная установка package не доказывает ни network reachability, ни разрешение на запись,
ни возможность открыть/разбудить существующую сессию.

## 2. Официальные возможности и наши проектные выводы

Проверка источников на 2026-11-03; доступность может зависеть от версии, плана, региона и
workspace policy. Ссылки подтверждают механизмы платформ, а не готовность нашей интеграции.

| Источник | Подтверждённая основа | Следствие для дизайна |
| --- | --- | --- |
| [Claude connectors](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities) | Web connectors доступны на Desktop и Mobile | Remote MCP — общий путь к сервису |
| [Claude local / remote connectors](https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors) | Desktop extensions работают локально; remote connectors доступны на разных поверхностях | Local extension и mobile connector требуют разных transports |
| [Claude plugins](https://support.claude.com/en/articles/13837440-use-plugins-in-claude) | Plugin объединяет skills/connectors; hooks и sub-agents исполняются не на всех поверхностях | Plugin presence не доказывает наличие local runner |
| [Claude Code plugins](https://code.claude.com/docs/en/plugins) | Plugin может включать skills, hooks и MCP | Нативный Claude Code package является тонким adapter |
| [OpenAI plugin architecture](https://developers.openai.com/plugins/concepts/plugins) | Skills, MCP и optional UI — разные формы package | Доменная логика остаётся в нашем ядре |
| [OpenAI plugin usage](https://learn.chatgpt.com/docs/plugins) | Документированы desktop/CLI и mobile Chat/Work surfaces | Chat/Work на телефоне не приравнивается к host Codex |
| [OpenAI remote connections](https://learn.chatgpt.com/docs/remote-connections) | Mobile может обращаться к connected host | Host-resident plugin требует работающего host |
| [OpenAI MCP authentication](https://developers.openai.com/plugins/build/auth) | Платформа определяет MCP/OAuth требования | Remote endpoint квалифицируется отдельно от local token |
| [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins) | Manifest и MCP declarations имеют native format | Package генерируется по проверенной схеме платформы |

Из этого не следует гарантированная поддержка каждого custom plugin во всех мобильных режимах.
Нужны actual-account проверки выбранной поверхности. Если функция недоступна, UI и README
показывают ограничение и маршрут через нашу веб-доску; уровень поддержки не повышается по docs alone.

## 3. Три маршрута подключения

### A. Local CLI / stdio

```text
Claude Code / Codex CLI / совместимый Desktop host
      │ plugin skill или MCP tool
      ▼
asana-cli agent ... / asana-cli mcp serve
      │ authenticated local interface
      ▼
local daemon ─ core ─ Asana
```

Существующий agent CLI остаётся самостоятельным путём к Asana. Новые board actions требуют
daemon; local MCP bridge — процесс транспорта, который завершится вместе с host client, но
не остановит daemon. В stdout stdio bridge попадает только MCP protocol, logs идут в stderr
с существующей redaction policy. SDK credentials принадлежат ядру, не bridge.

Если daemon отсутствует, возвращается structured `service_not_running` и инструкция для человека.
Установка плагина, tools/list или read tool не запускают service, не устанавливают executable
и не меняют credentials. Explicit human onboarding может отдельно выполнить start.

### B. Remote MCP / browser

```text
Claude cloud connector / поддержанная OpenAI plugin surface / mobile browser
      │ HTTPS + OAuth / authenticated web session
      ▼
gateway ─ scoped projection / routing / transport receipts
      ▲
      │ исходящее authenticated соединение
paired daemon ─ core ─ local credentials ─ Asana
```

Cloud connector должен достичь gateway из сети поставщика AI-клиента. Частный VPN, доступный
телефону и ноутбуку, не обязательно доступен cloud connector. Discovery localhost URL в manifest
не решает reachability. Gateway нельзя реализовать публичным tunnel на весь local admin server.

### C. Mobile control of host

```text
Codex mobile ─ platform remote connection ─ Codex на connected host
                                             │ host plugin / CLI tools
                                             ▼
                                         local daemon
```

Это подключение к агенту на host, а не исполнение CLI на телефоне. Оно не требует нашего gateway
для доступа host tools к local daemon. Оно не делает нашу веб-доску доступной mobile browser:
для неё нужен отдельный remote URL. Не смешиваем platform pairing и pairing нашего сервиса.

## 4. Матрица целевых способов подключения

Все новые строки имеют статус `planned / qualification required`. Существующее evidence для
direct Codex/Claude Code CLI не распространяется на MCP, native plugins и desktop/mobile.

| Клиент | Основной package | Tool transport | Полная доска | Ограничение |
| --- | --- | --- | --- | --- |
| Claude Desktop: Chat | Account plugin с remote connector | Public HTTPS MCP → gateway → daemon | Remote browser URL; embedded view только после проверки | Chat connector может исполняться вне локальной сети |
| Claude Desktop: local extension | Desktop extension package | Local stdio bridge → daemon | Loopback browser URL | Extension не становится mobile connector |
| Claude Mobile | Remote connector + доступные account skills/plugin features | Public HTTPS MCP → gateway → daemon | Responsive remote URL | Нет запуска local binary на телефоне |
| Claude Code CLI | Native plugin с общими skills и optional MCP declaration | Direct agent CLI либо stdio bridge | Local URL при работе на том же host; remote URL иначе | Hooks не являются постоянным worker |
| Codex Desktop | Native OpenAI plugin; local route отдельно проверяется | Scoped remote MCP либо доступные host-local tools | Browser URL; native UI resource optional | Не предполагаем наличие shell в каждом режиме |
| Codex Mobile: host session | Plugin установлен на connected host | Platform remote control → host plugin → daemon | Remote browser URL отдельно | Host должен быть доступен |
| Codex Mobile: Chat/Work plugin surface | Общий plugin с remote MCP, если доступен аккаунту | Public HTTPS MCP → gateway → daemon | Remote URL; inline view conditional | Это отдельная поверхность от host Codex session |
| Codex CLI | Native plugin/существующие managed skills | Direct agent CLI, stdio или явный HTTP MCP | Browser URL на доступном host | Нельзя автоматически менять config или broad tool policy |

Нативное приложение на Windows может быть remote-клиентом macOS/Linux daemon. Это не означает
поддержку Windows executable: существующая POSIX runtime matrix остаётся отдельной гарантией.

## 5. Claude Desktop

У пользователя есть два осмысленных режима, и onboarding должен явно предложить их.

Local mode:

1. Пользователь устанавливает CLI обычным поддерживаемым способом и запускает daemon.
2. Устанавливает desktop extension после просмотра requested capabilities.
3. Extension запускает только MCP bridge с фиксированными args, без bundled PAT и shell wrapper.
4. Bridge находит owner-controlled daemon, проверяет versions и выдаёт scoped tool list.
5. «Открыть доску» возвращает local URL, полученный от ядра, без постоянного token.
6. Закрытие Desktop завершает bridge; задачи и daemon продолжают жить.

Установка desktop extension через GUI/managed policy не имитируется записью неподтверждённых
settings файлов. Формат package и наличие runtime проверяются реальной установкой в поддержанной
версии Desktop. Extension artifact не распространяет исполняемый код другого клиента.

Remote Chat mode:

1. Пользователь добавляет plugin/connector, проходит OAuth нашего gateway.
2. Выбирает paired host и workspace; gateway проверяет local consent и scopes.
3. Claude получает metadata доски и curated tools, без PAT и host filesystem paths.
4. Полная доска открывается на authenticated remote origin.
5. При offline host connector честно сообщает stale/offline и не обещает выполнение.

Доступность local connector в конкретном Chat/Cowork mode — qualification item. Плагин не должен
пытаться «исправить» cloud reachability выдачей URL `http://127.0.0.1` cloud tool runner.

## 6. Claude Mobile

Базовый путь — remote connector. Local extension package на телефон не устанавливается.
Plugin может переносить инструкции, но наличие native plugin browser/skills на выбранной mobile
поверхности проверяется отдельно. Connector остаётся полезным без автоматического skills discovery.

Сценарий «что ждёт меня»:

1. Пользователь вызывает connector в мобильном разговоре.
2. Tool получает bounded список work items `wait_user` в выбранном scope.
3. Ответ показывает причины, next steps, source freshness и ссылки на конкретные карточки.
4. Пользователь открывает карточку на responsive web-доске и подтверждает доступное действие.
5. Результат появляется на доске; следующий tool read получает receipt/revision.

Управление локальным процессом с телефона не включается в обычный read/write toolset. Если
пользователю нужен stop, это отдельная authenticated web action с lifecycle scope. После stop
connector видит offline; start требует работающего отдельного host runner. Никакого обещания
«телефон разбудит выключенный ноутбук».

Мобильный reconnect, истёкшая OAuth session, смена сети, background/foreground и revoked pairing
проверяются отдельно. UI не теряет неотправленный текст при повторной аутентификации, но не
сохраняет исполняемую offline Asana mutation для неожиданной отправки позже.

## 7. Claude Code CLI

Существующий managed skill продолжает работать и не требует перехода на MCP. Native plugin
пакует общие workflows, optional local MCP declaration и проверенные metadata. Не нужно
поддерживать две копии инструкций и два набора Asana operations.

Целевой workflow:

1. В начале задачи прочитать exact worktree binding существующим curated action.
2. По явному выбору пользователя связать work item с текущей session identity.
3. На вехах отправлять локальный status/next и проверять очередь адресованных команд.
4. Перед записью Asana подготовить immutable operation; сохранить существующую host approval.
5. После открытия MR/PR опубликовать canonical change ref и выполнить явный handoff.

Hooks optional и могут публиковать только разрешённые bounded события. Они не читают все
транскрипты, не создают shared coordinator автоматически, не запускают service и не устанавливают
CLI. Нативное hook событие должно передавать реальный session ID; при его отсутствии используется
регистрация с явным opaque binding, а не поиск по всей домашней директории.

Текущий рабочий каталог и worktree context сохраняются при вызове CLI; daemon не получает
arbitrary path для чтения. Remote SSH session не выдаёт local laptop URL как кликабельную доску
без проверки того, где реально находится browser.

## 8. Codex Desktop

Основной package следует текущему OpenAI plugin format: общие skills + MCP declarations,
optional UI resource. Точный manifest генерируется по официальной схеме, а не копируется из
Claude package. Native local tools и remote connector проверяются как разные adapters.

В local/host режиме при наличии shell plugin может использовать существующий CLI contract.
В connector режиме tools идут через gateway. Capability negotiation выбирает доступный маршрут
явно; нельзя при отказе scoped MCP тихо переключиться на более привилегированный shell action.

Plugin поддерживает read board, show work item, publish work state, request refresh, prepare
Asana operation и show result. Запрос на выполнение агентом работы создаёт command receipt;
сама установка plugin не даёт фоновому ядру право запускать новый Codex turn.

Codex-specific resume/deep link/API допустим только после проверки официального интерфейса
и actual-client eval. В отсутствие этого показываем ссылку на доску и копируемый prompt.
Не читаем private SQLite приложения, не парсим скрытые session stores и не эмулируем клики.

## 9. Codex Mobile

Два независимых сценария должны иметь разные строки evidence.

Host session:

- пользователь устанавливает plugin на host Codex и подключает мобильный клиент штатным
  механизмом платформы;
- host agent вызывает local CLI/MCP и публикует статусы на общую доску;
- phone контролирует разговор/approval через платформу в пределах её возможностей;
- наш сервис не реализует и не хранит platform remote-control credentials;
- host offline означает недоступность host tools; последняя доска может быть доступна через gateway.

Account remote plugin:

- используется поддержанная Chat/Work plugin surface в мобильном приложении;
- tool исполняется через HTTPS gateway независимо от наличия CLI на телефоне;
- это не обещание, что plugin автоматически установлен или доступен в каждом Codex remote thread;
- общий account OAuth не подменяет pairing с конкретным daemon;
- если surface недоступна, остаётся responsive web-доска и host session, когда host online.

Нельзя сертифицировать Codex Mobile одним тестом мобильного browser или Codex CLI. В evidence
записываются mode, client version, OS, account/workspace restrictions и реальный execution location.

## 10. Codex CLI

Текущая `.agents/skills` интеграция остаётся supported на основании её существующего evidence.
Новый native plugin и MCP route получают свои records, не наследуют qualification автоматически.

Пользователь выбирает direct CLI либо plugin MCP. Project package не содержит machine-specific
localhost token, account ID или absolute path. Конфигурация local endpoint формируется отдельно
из owner-controlled state; remote endpoint содержит только публичный origin, auth проходит отдельно.

Команды service start/stop и установка integrations остаются human management surface.
Agent capabilities описывают board reads, разрешённые local state writes и bounded command polling;
они не включают auth management, generic API, filesystem access и service kill.

## 11. Единый curated MCP interface

Ниже семантические имена проектируемых tools, а не уже существующие MCP declarations.
Конкретные native tool names, schemas и annotations генерируются из runtime contract.

| Семантическая операция | Effect | Особенности |
| --- | --- | --- |
| `profile` / `capabilities` | read | Минимальная identity и фактически разрешённые scopes |
| `board.list` / `work.get` | read | Pagination, минимальные fields, freshness |
| `task.resolve` / `task.get` | read | Переиспользует текущую exact resolution и content budgets |
| `work.track` / `work.untrack` | local tracking write | Меняет desired tracking, не Asana task |
| `work.patch` / `work.handoff` | local work write | Expected revision, assignment epoch и actor scope |
| `sync.refresh` | bounded network read | Debounce/rate budget, без произвольного URL |
| `session.register` / `session.heartbeat` | presence write | Identity привязана к соединению, минимум metadata |
| `commands.poll` / `commands.ack` | command receipt | Только своя session, cursor/lease/expiry |
| `task.prepare-*` | prepare | Существующий immutable operation journal |
| `operation.get` | read | Ограниченный результат, без payload secrets |
| `operation.apply` | remote write | Только с действительным approval и policy/live guards |
| `board.open` | navigation | Safe URL/resource для выбранного клиента, без постоянного secret |

`approve`, `auth`, `raw request`, `api call`, `exec`, arbitrary file read и lifecycle stop
не входят в обычный agent toolset. Human UI имеет отдельные capabilities и handlers.
MCP destructive/read-only annotations — подсказки host, а не механизм server authorization.

Read-only connection не получает local write scopes. Track/handoff/presence — реальные эффекты,
поэтому не маркируются read-only ради удобства model planning. MCP session ID и request ID не
являются user identity и не заменяют authenticated principal.

Tool errors имеют bounded categories: `auth_required`, `scope_denied`, `service_not_running`,
`host_offline`, `version_incompatible`, `revision_conflict`, `approval_required`, `operation_unknown`,
`rate_limited`, `resync_required`. Они не содержат raw SDK/network objects, cookies, local paths
или stack. Retryable flag не разрешает автоматически повторять remote mutation.

## 12. Skills и plugin packaging

Сохраняем существующие canonical skills и добавляем небольшой workflow layer для доски:
разобрать inbox, опубликовать status, передать отслеживание, запросить проверку и показать approval.
Skill выбирает доступные tools по capabilities и не хранит environment-specific инструкции.

Предлагаемые source/output группы:

```text
source:  skills/source/ + integrations metadata + curated tool schemas
                           │ deterministic generators
                           ├─ existing managed skill bundles
                           ├─ Claude Code native plugin
                           ├─ Claude Desktop local extension
                           └─ OpenAI native plugin
```

Формат manifest каждого host имеет свой generator/validator. Shared descriptions и workflow
тексты имеют один authoritative source. Копии маркируются generated; исправления не вносятся
в built package вручную. Native manifests не заявляют tools/capabilities, отсутствующие в binary.

Install lifecycle сохраняет plan/dry-run, ownership hashes, conflict detection, atomic update,
rollback и безопасный uninstall. Native marketplace installation остаётся в host UI, если платформа
не предоставляет поддержанного management interface. CLI не изменяет чужие config files молча.

Plugin artifact не содержит credentials, user state, session transcripts, internal URLs из
реальных задач и auto-allow на broad tools. Добавление native plugin не удаляет существующие
skills и не устанавливает глобальные policy defaults. Удаление plugin не останавливает daemon
и не стирает board DB; disconnect/revoke — отдельные явные действия.

## 13. Identity, pairing и права

Различаем четыре сущности: человек в нашем сервисе, OS user/daemon device, identity AI-host
connection и внешняя агентная session. Совпадающий display name не связывает их автоматически.

Remote onboarding:

1. Пользователь открывает local Connections и создаёт одноразовый pairing request.
2. На gateway входит в свою учётную запись; проверяет выбранный device и workspace.
3. На local host подтверждает actor и scopes: metadata read, optional content read, local work write.
4. Устанавливается исходящее daemon connection с device credential, доступным только владельцу.
5. В AI-клиенте проходит OAuth к gateway; granted scopes пересекаются с local pairing scopes.
6. Human UI может выдать точечное approval; plugin не выдаёт себе approve scope.
7. Disconnect/revoke немедленно закрывает соответствующие sessions и отменяет недоставленные grants.

Gateway authorization проверяет user → tenant → paired device → workspace → operation effect.
Во всех запросах device выбирается явно либо однозначным закреплённым connection; произвольный
task GID не переключает tenant. Два пользователя с одинаковым Asana workspace не делят данные
без отдельного team-sharing дизайна.

OAuth защищает соединение пользователя с нашим сервисом, а Asana PAT авторизует outbound Asana.
Это разные credentials и разные permissions. Remote scope не может превысить Asana доступ или
локальную host policy. Новый gateway не принимает PAT через chat, query string или plugin settings.

Refresh tokens и device keys хранятся безопасно; access tokens короткоживущие, audience-bound.
Нужны PKCE/state, exact redirect URI validation, resource/audience checks и revocation по текущим
MCP/OAuth требованиям. Нельзя самостоятельно ослабить платформенные требования ради localhost demo.

## 14. Веб-доска и интерфейс внутри AI-клиента

Полная доска — отдельный first-party web app. AI-клиент всегда может вернуть обычную ссылку
на доступный authenticated origin. Remote ссылка указывает gateway origin, local — loopback
только для клиента на том же host. Local path и bootstrap credential не отправляются cloud model.

Embedded UI — optional adapter общего read projection: список «ждёт тебя», одна карточка,
preview operation. Он не загружает целую admin-доску в iframe с ambient local cookies. Actions
всегда вызывают scoped tools/HTTP handlers; sandboxed widget не получает Asana PAT или authority
на approve из-за того, что отображается внутри клиента.

Перед включением UI resource проверяются конкретные host requirements, CSP, navigation,
OAuth/session isolation, supported mobile behavior и tool-result bindings. Неисполняемый resource
имеет fallback text + link. Parent/iframe postMessage принимает только известные origin и schemas.
Общий дизайн tokens/components можно переиспользовать, auth context — нельзя переносить молча.

## 15. Команды в разговор и автоматизация

Plugin даёт агенту возможность опубликовать status и забрать command. Это pull workflow до
появления подтверждённого active-runner adapter. Браузер показывает «в очереди» для неподключённой
сессии, а не «отправлено в Claude/Codex» без receipt.

Сервис не будит произвольную закрытую сессию. Нативный runner, если будет добавлен, требует
explicit opt-in, ограниченного рабочего каталога, scope, budgets, cancellation и host audit.
Provider API/SDK invocation — отдельный execution backend с собственным billing и credentials;
подписка пользователя на desktop client не считается автоматически доступным API credential.

Handoff обновляет owner/epoch в ядре, сохраняет context summary и связанные refs. Он не экспортирует
полные private transcripts между поставщиками. Пользователь видит, какие данные передаются другому
агенту. Content Asana/MR остаётся external-untrusted и не может подменить target или policy.

## 16. Qualification и заявленная поддержка

Новые support dimensions: client surface/version, package type, transport, execution location,
read/local-write/remote-write effects, UI mode, presence и command handling. Генерируемая матрица
не должна схлопывать их в одну строку `codex supported` или `claude supported`.

Для каждого из шести запрошенных клиентов требуется отдельный проверенный record:

- чистая установка/подключение, discovery skills/tools, update и uninstall/revoke;
- bounded read и no-content default; явное content read в рамках scope;
- одна и та же карточка/revision в UI, CLI и tool response;
- no-PAT, revoked auth, другой tenant/device/workspace и offline host;
- prepare/preview, отказ в self-approval, разрешённый apply и `unknown` без автоповтора;
- malicious task/MR content не становится командой, URL или изменением permissions;
- queued/accepted/completed различаются; unsupported push честно помечен;
- safe navigation/fallback, mobile background/reconnect и client restart;
- version mismatch и revoke закрывают доступ без утечки credentials.

Evidence содержит exact binary/plugin/contract digests, client build/version, платформу, дату,
mode и выполненные сценарии. Artifact validation или documentation research дают только
`experimental/planned`, не `supported`. Если реальный клиент недоступен для проверки, это явно
остаётся ограничением выпуска и issue, а результат не заменяется выдуманным PASS.

## 17. Последовательность подключения клиентов

1. Сохранить current direct CLI support и добавить local board workflows.
2. Реализовать curated MCP stdio bridge и native Claude Code/Codex CLI packages.
3. Проверить Claude Desktop local extension и Codex Desktop доступные local routes.
4. Реализовать gateway/OAuth/pairing и remote UI в пределах approved remote scope.
5. Подключить Claude Desktop Chat/Mobile и OpenAI remote plugin surfaces.
6. Отдельно проверить Codex Mobile host session и mobile account plugin modes.
7. Добавить embedded UI там, где он подтверждён и улучшает сценарий.

Приоритет — корректная общая доска и одинаковые операции. Шесть различных наборов бизнес-правил,
шесть credential stores или шесть механизмов синхронизации Asana не создаются.
