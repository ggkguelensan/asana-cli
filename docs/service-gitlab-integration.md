# GitLab: SDK, glab и подписки для core и views

Статус: проектный контракт SVC-009, 2026-11-03. В runtime проекта GitLab adapter, webhook ingress
и scheduler ещё не реализованы. Read-only проверка `glab` и API настроенного self-managed host
подтвердила доступность GitLab API; никакие hooks/подписки/настройки GitLab не изменялись.

## 1. Решение

Core использует собственный GitLab module с типизированным domain interface. Основной HTTP
adapter — `@gitbeaker/rest`; альтернативный adapter — установленный `glab api` с его credential
context. SDK и CLI не попадают в browser/view bundle и не диктуют core schemas.

GitLab перечисляет `@gitbeaker/rest` среди community Node.js клиентов и прямо отделяет их от
официально поддерживаемых библиотек. Gitbeaker документирует TypeScript и native-fetch wrapper
для Bun/Node/browser. Это разумный кандидат для Bun service, но его наличие не доказывает
полное покрытие endpoints конкретной self-managed версии или standalone compilation.
Версия закрепляется после 14-дневного quarantine, dependency audit и реального Bun/binary smoke.
Сейчас новая dependency не добавляется как неиспользуемый scaffold.

## 2. Adapter вместо зависимости от инструмента

```text
CLI / base board / generated view
              │ typed capabilities + deterministic commands
              ▼
          core GitLab port
          ├── Gitbeaker adapter → GitLab REST API
          └── glab adapter     → glab api → GitLab REST/GraphQL API

GitLab webhooks / scheduled bounded refresh
              ▼
        shared source synchronizer → invalidation → core WS → все views
```

Target package `packages/gitlab-client` соответствует реальному SDK/tool adaptation module.
Пустой universal `Provider.invoke(anything)` не заменяет domain interface. Asana и GitLab имеют
разные types, permissions и события; общими остаются error categories, budgets, credential refs,
receipt semantics и application lifecycle, а не искусственный общий SDK class registry.

Первая вертикаль — identity, resolve project, read MR + pipelines + approvals/discussions,
watch/reconcile. Write capabilities добавляются из use cases с отдельными tests, а не считаются
автоматически доступными из-за наличия метода в Gitbeaker.

Примеры целевых domain operations (названия уточняются implementation PR):

```ts
interface MergeRequestRef {
  connectionId: string;
  projectId: number;
  iid: number;
}
// readMergeRequest, listMergeRequests, readPipelines, readApprovalState,
// readDiscussions; затем addNote, resolveDiscussion, approve, merge.
```

`projectId` — canonical ID внутри выбранного GitLab connection, `iid` — project-local MR number.
`!4` или GitLab global MR ID не заменяют эту пару. Connection привязывает API origin и actor.
Project path/URL сначала разрешаются через выбранный host; rename проекта не меняет identity.
DTO фиксируют source timestamps, fetched_at/freshness, SHA/версии, capabilities и partial results.
Отсутствующая premium feature, `403`, `404`, revoked token, pagination limit и provider outage
различимы; пустой массив не означает «нет данных» при denied/unavailable response.

## 3. Как применять glab

`glab api` умеет authenticated REST v4 requests и GraphQL. У backend adapter фиксируются
hostname, HTTP method, endpoint и JSON input; repo placeholders и cwd-dependent host discovery
не используются. Пример чтения, project/MR IDs вымышленные:

```sh
glab api --hostname gitlab.frhc.one --method GET projects/123/merge_requests/4
```

Core запускает argv-массив без shell interpolation. Body передаётся stdin, stdout ограничен
по bytes/time и валидируется как JSON; stderr проходит redaction. Не парсим human-readable
`glab mr view` text. `glab` path/version и credential actor проверяются при подключении; view
не задаёт executable, flags, hostname или произвольный shell command.

Режимы connection выбираются явно:

- SDK connection использует отдельный GitLab token/credential provider в OS secret store.
- glab connection делегирует requests `glab`, используя его per-host auth; core не вызывает
  `glab auth token` ради копирования/печати секрета.
- Auth environment glab имеет precedence над stored credential. Adapter должен исключать
  случайный ambient GitLab/CI token и repo/host overrides, либо явно pin-ить выбранный режим.
- glab может хранить credentials в keyring или config fallback; выбор этого режима не является
  гарантией, что credential уже защищён keyring. Наш SDK mode не создаёт plaintext fallback.
- Standalone core не требует установленного glab: default transport SDK. glab — opt-in для
  использования существующей настройки пользователя/совместимости.

Switch SDK ↔ glab — изменение connection transport/actor, не скрытый retry. После неоднозначного
write нельзя повторять mutation другим adapter-ом. Автоматические SDK/HTTP retries проверяются
отдельно: неидемпотентные notes/approvals/merge не должны повторяться непрозрачно для receipt.
Asana PAT и GitLab credential независимы. Host выбирается из registered connection, не из
текста task/MR и не из browser URL без проверки владельцем.

## 4. «Подписаться» означает разные вещи

| Механизм | Что даёт | Роль в нашем сервисе |
| --- | --- | --- |
| `glab mr subscribe` / GitLab MR subscribe endpoint | Уведомления GitLab текущему пользователю | Отдельное пользовательское действие; не event stream core |
| Project/group webhooks | HTTP POST о provider events | Основной push-путь при наличии permissions и reachable ingress |
| GraphQL subscriptions | Ограниченный набор real-time fields конкретной GitLab schema | Возможная оптимизация после feature detection, не обязательная основа |
| Scheduled REST/GraphQL refresh | Чтение current source facts | Обязательный fallback и reconciliation независимо от hooks |
| Наш `watch`/WebSocket | Versioned invalidation и доступные projection changes | Общий client interface для base board, CLI и custom views |

SDK method с названием `subscribe` не означает, что процесс SDK получает live events.
GitLab GraphQL действительно имеет subscriptions, но документация отмечает ограниченный набор.
Не обещаем generic WebSocket-подписку на каждый MR/pipeline/approval для любой self-managed версии.

## 5. Webhooks и polling

### Push-путь

```text
GitLab project/group hook
          │ reachable HTTP POST + проверяемый provider secret/signature
          ▼
owned webhook ingress / gateway
          │ outgoing authenticated paired-host channel при remote topology
          ▼
core inbox → validate/dedupe → coalesced resource refresh → normalized facts
                                                       → event outbox → WS
```

Project hook management требует соответствующих project permissions; group hooks имеют
собственные permissions/edition limits. Обычный Developer без hook-management rights всё равно
может читать разрешённые MR через polling. Наличие GitLab PAT или SDK не выдаёт роль Maintainer.

Project hook покрывает project, а не устанавливается отдельно для каждой карточки. Core ведёт
реестр собственных hook IDs, desired event types и credential/secret references; несколько views
и work items совместно используют subscription. Чужие hooks не изменяются и не удаляются.
Обновление/удаление собственного hook требует ownership proof и отдельного authorization effect.

На первом этапе нужны MR, pipeline, job и note/discussion-related events, поддержанные instance.
Payload — invalidation hint: core сверяет права и перечитывает требуемые source facts. Дубликат,
событие не по порядку или неполный payload не переписывает более новые facts. Merge одного MR
не завершает всю Asana task с несколькими change refs.

Ingress проверяет размер и authentication до использования payload; verification выбирается
по реально поддержанному secret/signature механизму GitLab instance. Секрет webhook отделён
от API token. Нельзя доверять одному лишь `X-Gitlab-Event` header или URL из payload.
Project/connection refs проверяются, delivery IDs используются для dedupe там, где доступны.
Acknowledgment выполняется после bounded durable inbox acceptance; refresh/scheduling идёт
асинхронно. Raw payload не становится бесконечным mirror task/comment content в SQLite.

GitLab server должен достичь callback из своей сети. Loopback ноутбука ему недоступен по
определению. Для частного GitLab может подойти согласованный ingress внутри корпоративной сети;
для portable laptop — narrow gateway, достижимый GitLab, с исходящим каналом к core. VPN на
браузере или наличие glab не создают callback reachability. HTTP admin API не публикуется наружу.

### Polling/reconciliation

Работает даже без hooks и без публичного ingress. Один core scheduler объединяет одинаковые
resource watches base board и custom views. Есть budgets, pagination caps, backoff/jitter,
rate-limit handling, conditional requests где поддерживаются и slower refresh для inactive work.
Ни агент, ни каждый iframe не создают собственный poll loop к GitLab API.

Refresh запускается при track/link, webhook hint, reconnect/resync, перед guarded write и по
ограниченному расписанию. Shared scheduler коалесцирует bursts. Resource freshness видна клиенту;
нет обещания мгновенного обновления во всех topology modes. Полный account/project mirror не нужен.
GitLab activity Events API не считается надёжным полным changelog всех approval/CI transitions.

Restart/crash восстанавливает desired watched refs и reconcile schedule. Нет обязательного
persisted task cache: в SQLite достаточно subscription metadata, hook ownership/receipts,
dedupe retention и существующих change/work relations. API/hook secrets остаются вне БД.
Untrack или закрытие view уменьшает refcount, не удаляя общий hook, пока он нужен другому scope.
Hook disabled/delivery failure переводят источник на polling/degraded, а не в фиктивное live.

## 6. Как GitLab появляется в generated view

View получает безопасные DTO через [view SDK/host bridge](service-extensible-views.md):
таблицу MR, pipelines/CI, approvals, unresolved discussions, diff metadata по явному запросу.
Токены, `glab`, Gitbeaker objects и shell не экспортируются. Данные GitLab, включая descriptions,
notes и diff, остаются недоверенным text/content; raw HTML не встраивается в parent DOM.
Большие diffs/job traces требуют отдельного content budget и не скачиваются автоматически.

Read-only dashboard можно собрать сразу после появления query capabilities. Комментарий,
resolve thread, approve, merge или retry pipeline — разные effects с собственными handlers,
request IDs и provider guards. View button вызывает capability, а не `glab` command string.
Approve должен учитывать конкретный head SHA; merge/CI/precondition semantics проверяются по
реальному API instance, а не только по зелёному badge в устаревшем snapshot.

Новый backend functionality добавляется как проверяемая capability. Это позволяет агентам
создавать произвольные новые views, сохраняя единый детерминированный mutation path и default
provider permissions пользователя. Отсутствие реализации отличается от policy/provider denial.

## 7. Acceptance SVC-009

- SDK adapter tested на Bun и compiled binary без glab/source checkout; maturity/audit dependency checks;
- glab adapter tested с fake executable и local API fixtures: explicit host, stdin JSON, timeout,
  output caps, malformed data, unavailable binary, auth precedence, actor mismatch и no secret output;
- read/write ports имеют одинаковые DTO/errors/receipts; transport switch не дублирует write;
- MR/project IDs и permissions проходят validation; unsupported features имеют явный status;
- polling-only mode работает для обычного reader без hook-management permissions;
- hooks: ownership, duplicates/out-of-order, invalid auth, burst coalescing, restart, revoked
  API permission, disabled hook и reconcile recovery; shared refs не удаляют чужую subscription;
- новая вкладка/view не создаёт N дополнительных provider pollers/hooks;
- base board, CLI и custom view получают одинаковую freshness и canonical refs;
- реальный self-managed host квалифицируется отдельно; private tasks/token/payloads не коммитятся.

## 8. Источники, проверены 2026-11-03

- [GitLab community API clients](https://docs.gitlab.com/api/rest/third_party_clients/) и
  [Gitbeaker maintainer repository](https://github.com/jdalrymple/gitbeaker).
- [glab api](https://docs.gitlab.com/cli/api/),
  [glab authentication](https://docs.gitlab.com/cli/authentication/),
  [glab auth login storage](https://docs.gitlab.com/cli/auth/login/),
  [MR notifications subscription](https://docs.gitlab.com/cli/mr/subscribe/).
- [Project hooks API](https://docs.gitlab.com/api/project_webhooks/),
  [webhook event families](https://docs.gitlab.com/user/project/integrations/webhook_events/),
  [limited GraphQL subscriptions](https://docs.gitlab.com/development/fe_guide/graphql/),
  [approval API and SHA](https://docs.gitlab.com/api/merge_request_approvals/).

API/SDK capabilities выше взяты из этих источников. Выбор primary SDK, glab alternative,
shared scheduler и ownership модели — наши проектные решения, а не готовые runtime features.
