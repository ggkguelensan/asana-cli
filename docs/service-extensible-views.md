# Views, которые агент собирает по запросу пользователя

Статус: целевой контракт, 2026-11-03. Сейчас web — React/Jotai/Vite source application;
registry, view SDK, runtime bridge и установка HTML packages ещё не реализованы. Этот документ
определяет SVC-011 и уточняет границы из [launch/auth audit](service-launch-and-auth-audit.md).

## 1. Возможность продукта

Пользователь может попросить «покажи мои MR с упавшим CI рядом с задачами Asana», «сделай
календарь», «добавь dashboard времени», «добавь новую форму». Агент создаёт новый view, tab,
страницу или panel, используя готовый UI и capabilities детерминированной основы. Для каждого
варианта не нужно переписывать основную доску, запускать новое ядро или поддерживать агента
постоянно онлайн. Собранный view работает и после завершения разговора.

Это не ограничение фиксированным набором widgets. Агент может писать произвольную HTML/CSS
композицию и TypeScript/React логику представления. Доступ к данным и изменениям проходит через
предоставленный core interface. Если новое пожелание требует отсутствующей backend capability,
агент добавляет и проверяет такую capability в core отдельно; view не получает обходной путь
через shell, SQL, SDK с PAT или eval на сервере.

| Часть | Может менять агент при создании view | Authority |
| --- | --- | --- |
| Композиция, таблицы, графики, формы, фильтры, группировка | Да | View source и собственное view state |
| Использование готовой карточки, секции, формы или всей доски | Да, через public UI modules | Общая UI library |
| Запросы к Asana/GitLab, workflow actions, live updates | Да, через доступные versioned capabilities | Core/provider adapter |
| Смысл завершения задачи, revision, approval, idempotency | Через отдельное изменение core и его contracts | Детерминированное ядро |
| PAT, shell, service DB, bootstrap session/admin secrets | Не являются view APIs | Runtime/credential modules |

## 2. Два способа расширения

### Доверенное изменение source приложения — доступно сейчас

Агент в checkout может добавить TSX module в `apps/web`, подключить его в композицию App и
переиспользовать существующие React modules. Это обычное доверенное изменение исходников:
полученный код имеет те же полномочия, что приложение. Это **не** sandboxed runtime extension.

Пример source-only view для файла `apps/web/src/views/review-focus/View.tsx`:

```tsx
import { useAtomValue } from 'jotai';
import { boardAtom } from '../../state/atoms';
import { BoardSection } from '../../components/BoardSection';

export function ReviewFocusView() {
  const board = useAtomValue(boardAtom);
  const reviews = board?.items.filter((item) => item.kind === 'review') ?? [];
  return <BoardSection title="Мои ревью" items={reviews} empty="Ревью пока нет" />;
}
```

Module монтируется внутри существующего Jotai Provider и lifecycle приложения, где уже
загружен snapshot. Компонент карточки использует существующий selection/details flow.
Пример не создаёт новую session, controller, business state machine или второй SDK client.
Это инструкция для автора, а не уже добавленный product screen.

Vite собирает TS/TSX в browser HTML/assets; в Git не добавляется авторский JavaScript.
`bun run typecheck`, `bun run check` и browser tests проверяют интеграцию. Текущий direct HTTP
client находится в `apps/web/src/api/client.ts`, wire schemas — в `packages/contracts`.
`TaskCard` и часть прочих компонентов пока завязаны на app atoms: их нельзя обещать как готовую
независимую component library. Следующий extraction должен заменить эту связь props/callbacks,
оставив Jotai selection adapter в host.

### Установка view на работающий core — следующий runtime scope

Агент создаёт отдельный TS/TSX view project, собирает static HTML bundle и регистрирует
versioned view package. Host отображает его отдельным tab/page/panel. Это HTML для нашего view host. Открытие `file://` или HTML в стороннем Claude/Codex artifact
само по себе не создаёт session/bridge к core; такие hosts требуют отдельного adapter и
auth/compatibility qualification. Нельзя обходить это выдачей PAT или wildcard CORS.

Core и базовая доска
не пересобираются для каждого пользовательского layout. Обновление view атомарно заменяет
bundle; можно отключить его или откатить revision без изменения рабочих задач.

Inline business logic, dynamic server imports и installation scripts в daemon не исполняются.
Build выполняет разрешённый локальный tool/человек с pinned toolchain, вне процесса core.
Запрос «сделай такой view» разрешает обычные обратимые source/build/activation действия в
уже выданных capabilities. Новые permissions, SDK/backend modules и внешние writes не
возникают из текста generated HTML или manifest автоматически.

## 3. Топология и общие modules

```text
Сейчас
apps/web: App + Jotai + компоненты + HTTP client → будущий core API

Цель
agent / человек → TS/TSX view source → build → static HTML package
                                                   │ registry + digest
web shell ─── built-in BoardView                     ▼
          └── isolated custom view frame ─ view SDK ─ host bridge
                                                    │
                                         service client / typed API
                                                    │
                                       deterministic core → providers
```

Предлагаемые public packages, извлекаемые при реальных consumers, не пустые facades:

| Package/module | Содержимое | Граница |
| --- | --- | --- |
| `contracts` | Capability schemas, resource refs, commands, receipts, invalidations | Browser-safe; без cookies/PAT/SDK objects |
| `ui` | `BoardView`, TaskCard, Section, source freshness, forms, tokens/theme | React props/callbacks; без app-global atoms и network |
| `view-sdk` | Typed query/command/watch, cancellation, receipts, errors, host handshake | В frame работает через MessagePort; не читает service cookie |
| `service-client` | HTTP/WS для доверенного host/CLI; cookies/native auth остаются здесь | Не экспортируется привилегированным объектом в frame |
| Host view registry/bridge | Install/activate/revoke, manifest, permission binding, routing | Проверяет context, version, resource scope и effect |

Host и каждый view имеют собственный Jotai store. UI modules не импортируют host atoms,
repository paths или core storage. Export всей готовой доски должен быть presentation module
с явными props/ports; импорт `apps/web/src/app/App.tsx` не становится поддерживаемым SDK.
Themes/CSS нужно собирать в view bundle: iframe не наследует CSS родительской страницы.

## 4. Что получает агент для authoring

Core предоставляет versioned capability catalogue: operation ID, schemas input/output,
resource scopes, effect, freshness/limits, доступность provider и approval/receipt semantics.
Из тех же schemas строятся SDK types и reference docs. Эти определения не ведутся отдельно
в skill и в server implementation.

Authoring skill содержит:

1. Получить capabilities и versions; не придумывать недоступные endpoints/modules.
2. Выбрать данные и операции по запросу пользователя, описать необходимые permissions.
3. Создать TS/TSX project из template, используя UI modules и view SDK.
4. Проверить types/build, offline/error/empty states и requested capability set.
5. Показать/активировать immutable bundle в разрешённой области; host сохраняет provenance.
6. Проверить действие через receipt и обновлённые source facts, а не по изменению текста кнопки.

Планируемая authoring grammar — не существующие команды:

```sh
asana-cli views capabilities --json
asana-cli views init VIEW_ID
asana-cli views validate PATH
asana-cli views install PATH
asana-cli views open VIEW_ID
asana-cli views disable VIEW_ID
```

`views init` создаёт files в выбранном project directory. Source остаётся в checkout либо
отдельном `~/Projects/<view-project>`, а не в глобальной agent config или runtime state.
CLI не устанавливает agent configuration, package dependencies или hooks скрыто.

## 5. View SDK interface

Целевые операции SDK — query, command и watch с типами из catalogue. Ниже псевдокод interface,
не import из уже опубликованного package:

```ts
const board = await view.query('board.snapshot', { /* bounded projection */ });
const changes = await view.query('gitlab.merge_requests.list', { /* explicit project refs */ });
const stop = view.watch(['board', 'gitlab.merge_requests'], () => reload());
const receipt = await view.command('work.resolve_request', { /* exact target + revision */ });
```

В готовом authoring package operation names и schemas генерируются из core catalogue; строки
выше иллюстрируют семантику, а не объявляют доступный runtime API. API не ограничен навсегда
текущим board snapshot: новые registered queries/actions расширяют его версионированно.

- Query принимает bounded filters/fields/pagination и возвращает DTO, fetched_at/freshness,
  canonical refs и permissions. SQL или SDK class name не передаются через view bridge.
- Watch сообщает invalidation/resync/revoke; SDK coalesce-ит обновления, view получает новый
  snapshot. SDK/host закрывает streams и pending reads при unload/revoke.
- Command получает request ID, revision и immutable intent; проверяется тем же handler, что
  CLI и base board. Receipt + повторное чтение определяют результат. После timeout/unknown
  view не повторяет remote write и не переключается на `glab`/SDK самостоятельно.
- Authorization/approval UI принадлежит host/core. Кнопка внутри generated view не может
  выдать себе approval или подделать human provenance.
- Board data projection для frame исключает нынешний `csrf_token` и любые control/session
  secrets. Существующий `BoardSnapshot` нельзя без адаптации целиком переслать в custom frame.

## 6. Runtime isolation HTML

Custom code по умолчанию исполняется в sandboxed iframe с `allow-scripts`, без
`allow-same-origin`, доступа к parent DOM, top navigation, popups, forms и downloads.
Не применять одновременно same-origin privilege и scripts для недоверенного same-origin HTML.
React import в source означает build-time bundling, а не доступ к модулям host через window.

Self-contained HTML содержит compiled script/styles из TS/TSX. Host задаёт CSP с `default-src 'none'`, script/style nonce, ограниченными image sources,
`base-uri 'none'`, `form-action 'none'` и `connect-src 'none'`; remote scripts/assets не разрешаются. Это позволяет
оставить core API доступным через bridge без передачи browser cookies в generated code.
Конкретная схема nonce/CSP/srcdoc и browser compatibility проверяется implementation tests;
расширение не может ослабить sandbox/CSP собственным manifest.

Sandbox/CSP защищают host privileges, но не являются полной DLP гарантией для данных,
которые уже переданы исполняемому view: `connect-src` не контролирует все navigation channels.
Grant означает доверие к обработке выбранной projection этим code bundle. Если требуется
строгая egress isolation, нужен отдельно проверенный execution environment; iframe один её
не обещает. Source disclosure, permissions и minimal projections остаются обязательными.

MessageChannel создаёт host и привязывает к конкретному frame instance, activation revision и
permission grant. Handshake проверяет `event.source`; opaque origin `null` сам по себе не
идентифицирует отправителя. Transfer адресуется конкретному contentWindow, а не всем frames.
Messages проходят strict schemas, byte/count/rate limits, version и scope checks. Произвольное
поле `view_id` в сообщении не выдаёт права другого view. UI permission grant не заменяет
повторную проверку core перед исполнением operation.

Host chrome сохраняет название/автора/custom indicator и собственные dialogs. «Открыть MR»
проходит по проверенному canonical ref; arbitrary exfiltration URL не становится навигацией
host. CSP не отменяет влияние кода на его UI, поэтому view provenance/permissions всегда видны.
Service stop, credential setup, plugin installation и shell не выдаются как ambient view API.
Новые effects можно добавить отдельно через явную capability и host consent.

## 7. Persistence и жизненный цикл

В SQLite нужна небольшая registry: view ID/version, manifest/schema version, bundle digest,
permission grants и их revision, enabled state, safe source reference, автор/provenance,
installation/activation timestamps и versioned user preferences. UI filter/preferences имеют
свою schema/size limits. Это не повод сохранять task snapshots, comments или разговор агента.

Static artifacts лежат в owner-controlled runtime asset directory по content digest; runtime
не исполняет source и не хранит PAT в view files. Activation проверяет digest, limits, schema,
capability compatibility и local ownership; публикация в remote gallery — отдельное действие.
Глобальные source config/skills пользователя не меняются. Rollback меняет view revision,
не откатывает уже выполненные Asana/GitLab operations. Disable/revoke закрывает ports/watch и
блокирует новые commands; уже отправленный ambiguous write сохраняет receipt/unknown.

## 8. Порядок реализации и acceptance

SVC-011 зависит от человеческого service/auth vertical slice и typed capability catalogue.
Вначале извлекаются реальный service client и presentation UI из текущего web; затем authoring
SDK/template, manifest/registry и isolated runtime. Built-in board продолжает работать без
custom views и без агента.

Acceptance:

- агент собирает TSX view с готовой карточкой/BoardView и новым календарём/таблицей;
- HTML-only shell также использует bundled view SDK; arbitrary DOM composition поддержана;
- view работает после завершения agent session, после reload/restart и без AI credentials;
- те же операции через CLI, base board и view дают одинаковые domain transitions/receipts;
- реальные browser tests проверяют forged messages/identity, frame reload, revoke, stale
  revisions, unknown writes, attempted direct network/cookie/parent access и retained watches;
- GitLab/Asana credentials не попадают в bundle, frame DTO, protocol trace и host logs;
- source code remains TS/TSX; generated browser JS — только build artifact;
- validate/activate/rollback проверяют несовместимые capabilities и повреждённый bundle;
- `unsupported_capability` отличается от denied permission и unavailable provider.

## 9. Основа browser isolation

Browser mechanics проверены по [iframe sandbox](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe),
[postMessage](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage) и
[CSP connect-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src).
Manifest/SDK/permissions/registry — наши проектные решения; prototype и browser tests должны
подтвердить реальную комбинацию sandbox/CSP/MessageChannel перед объявлением runtime готовым.
