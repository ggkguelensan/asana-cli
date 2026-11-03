# Веб-доска asana-cli

Самостоятельное Vite-приложение: TypeScript, React и Jotai. Перенос композиции
`skills/task-windows/board.html` из Ticketon claude-plugin MR !4: «Ждёт тебя», «Мои задачи»,
«Ревью чужих MR» и свёрнутое «Готово». Artifact DB и обязательная сессия координатора удалены.

## Запуск

Из корня монорепозитория, Bun из корневого `packageManager`:

```sh
bun install --frozen-lockfile
bun run dev
```

Открыть `http://127.0.0.1:5173`. Для другого порта: `bun run --filter @asana-cli/web dev --port 5187`.
Режим примера включается только явно: `http://127.0.0.1:5173/?demo=1`.
Пример хранит синтетические данные в памяти и сбрасывается при перезагрузке; он не обращается
в Asana и не является реализацией business rules сервиса. Его режим всегда обозначен в UI.

Production assets:

```sh
bunx turbo run build --filter=@asana-cli/web
bun run --filter @asana-cli/web preview
```

Сборка находится в `apps/web/dist/`. Vite/Bun нужны при разработке/сборке, но браузер получает обычные
статические assets. Встраивание assets в CLI binary относится к реализации daemon и пока не
выполнено. Установка и lockfile общие для всего монорепозитория.

Для разработки с локальным backend:

```sh
ASANA_SERVICE_URL=http://127.0.0.1:8787 bun run dev
```

Vite проксирует `/api` вместе с WebSocket upgrade. Значение разрешает только credential-free
loopback HTTP(S) origin; оно не попадает в frontend bundle. Production использует same-origin
HTTP/WebSocket и session cookies. Нельзя передавать PAT в `VITE_*`, URL или browser storage.

## Структура

```text
apps/web/
├── src/main.tsx               Jotai Provider и выбор явного service/demo adapter
├── src/app/App.tsx            композиция страницы и lifecycle подключения
├── src/components/            карточка, секция, сводка, toolbar, dialogs, детали, уведомления
├── src/model/board.ts          view labels/types; wire schemas в packages/contracts
├── src/state/atoms.ts          Jotai atoms + derived поиск/фильтры/секции/счётчики/selection
├── src/state/connection.ts     snapshot, invalidation, reconnect, dispose и resync
├── src/state/controller.ts     команды, revision, pending, receipt и conflict/unknown handling
├── src/api/client.ts           authenticated HTTP/WebSocket adapter
├── src/api/demo-*.ts           изолированный disposable пример
├── src/styles/                tokens, темы, responsive layout и focus states
├── tests/                     Bun tests для state/transport boundaries
└── e2e/                       Playwright desktop/mobile browser scenarios
```

Состояние приложения принадлежит Jotai store. Компоненты не создают копию backend workflow:
`status` и доступные `actions` приходят от сервиса. Локальные derived atoms только фильтруют,
сортируют и группируют view projection. Никакие task data, commands или credentials не
сохраняются в localStorage/IndexedDB. Theme/filter/selection живут в памяти.

Модульные компоненты сохраняют семантические headings, keyboard navigation, focus-visible,
native modal dialogs с Escape и отдельное подтверждение остановки. Текст источников отображается
как React text; `dangerouslySetInnerHTML`, remote fonts и trackers не используются.

## Вход и подключение Asana

Авторизация сервиса и подключение Asana по PAT пока не реализованы. Текущий frontend
ожидает session cookie от будущего same-origin backend. Режим `?demo=1` не проверяет login.
Целевой [PAT/browser flow](../../docs/service-launch-and-auth-audit.md) использует owner-only
local setup и общий OS credential store с CLI; отдельный OAuth flow нужен для «Войти через Asana».

## Контракт подключения и текущая граница

Daemon/HTTP API ещё не реализован. По умолчанию приложение пытается подключиться к сервису;
ошибка или несовместимый ответ показывает отдельное состояние и никогда автоматически не
подменяется данными примера. Browser E2E использует контролируемый API fixture, а не настоящий daemon.

Предварительный client contract определяется в `src/model/board.ts`; окончательная server schema
должна стать общим contract в SVC-002 без дублирования domain rules во frontend.

| Surface | Contract |
| --- | --- |
| `GET /api/v1/board` | `asana-cli.board.v1`, snapshot/cursor, instance ID, workspace, CSRF token, capabilities и максимум 100 view items |
| `POST /api/v1/commands` | Typed command, stable client `request_id`, expected revision и exact action/target request IDs; CSRF в header |
| `GET /api/v1/commands/:request_id` | Receipt по тому же client request ID; queued/accepted/completed/failed/unknown |
| `WS /api/v1/events?cursor=…` | Same-origin cookie auth; cursor не credential; invalidation/resync/stopping events |

Поддержанные frontend commands: resolve request, complete/reopen local work, track task,
request source refresh и service stop. Операции Asana не имитируются и не реализуются обходным
raw API внутри браузера. Backend capabilities определяют видимость/доступность операций;
этот client subset не ограничивает целевой default user-equivalent доступ всего продукта.

Snapshot → stream subscription использует server cursor. Invalidation перечитывает snapshot;
event во время fetch вызывает дополнительное чтение. Перезапуск instance пересоздаёт stream.
Каждый React mount владеет своим abort/socket/timer, поэтому StrictMode cleanup не оставляет
подписок и не разрешает позднему старому запросу заменить данные нового mount.

Conflict вызывает перечитывание, без повторной отправки mutation. После потерянного ответа
делается bounded status lookup по тому же request ID; недоступный receipt остаётся unknown.
Клиент не пишет оптимистичный completed и не хранит offline очередь. Service-origin auth loss
удаляет защищённый snapshot; простой разрыв соединения оставляет последний снимок с отключёнными writes.

Следующий server этап должен реализовать same-origin auth/bootstrap, CSRF, ownership/policy,
стабильный request ID lookup, pagination и actual command semantics. Текущая web проверка
не является evidence готовности этих server guarantees.

## Проверки

```sh
bun run check
bunx playwright install chromium
bun run test:e2e
```

E2E запускает собственный Vite на `127.0.0.1:4197` и не переиспользует чужой процесс на порту.
Проекты: desktop Chromium и mobile Chromium viewport/touch emulation; это не qualification
нативных iOS/Android приложений. Проверяются human flow, фильтры, tracking, stop confirmation,
invalidation, конфликты, потерянный acknowledgement, malformed/auth responses, escaped source text
и темы. Скриншоты примера лежат в ignored `test-results/`.

В CI приложение имеет отдельный build/typecheck/unit/browser job. Test discovery ограничен
`tests/` каждого package: CLI release gates не собирают frontend tests и не требуют web dependencies.
`bunfig.toml` ссылается на root policy, поэтому 14-day dependency quarantine и test discovery
имеют один authoritative source. Версии фиксированы отдельным lockfile.
