import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { exampleBoard } from '../src/api/demo-data';

async function service(page: Page) {
  const board = exampleBoard();
  const sockets: WebSocketRoute[] = [];
  await page.route('**/api/v1/board', (route) => route.fulfill({ json: board }));
  await page.routeWebSocket('**/api/v1/events?*', (socket) => { sockets.push(socket); });
  return { board, sockets };
}
async function resolveFirst(page: Page) {
  await page.goto('/');
  await expect(page.getByText('На связи', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Выбрать вариант экрана оплаты' }).click();
  const dialog = page.getByRole('dialog', { name: 'DEMO-101' });
  await dialog.getByRole('button', { name: 'Решение принято' }).click();
  return dialog;
}
async function expectSingleCommandResult(page: Page, message: RegExp, postCount: () => number) {
  const dialog = await resolveFirst(page);
  await expect(dialog.getByText(message)).toBeVisible();
  expect(postCount()).toBe(1);
}

test('example board has search, filters, archive and responsive layout', async ({ page }, info) => {
  await page.goto('/?demo=1');
  await expect(page.getByRole('heading', { name: 'Окна задач.' })).toBeVisible();
  await expect(page.getByText('Данные примера.', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Ждёт тебя' }).getByRole('article')).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('board.png'), fullPage: true });
  await page.getByRole('searchbox').fill('ЭКСПОРТ');
  await expect(page.getByText('Показано 1 из 8')).toBeAttached();
  await expect(page.getByRole('article')).toHaveCount(1);
  await page.getByRole('searchbox').fill('');
  await page.getByRole('button', { name: 'Ревью', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(2);
  await page.getByRole('button', { name: 'Все', exact: true }).click();
  await page.locator('summary').click();
  await expect(page.getByRole('button', { name: 'Исправить навигацию с клавиатуры' })).toBeVisible();
});

test('human can resolve, complete and reopen work without an agent', async ({ page }) => {
  await page.goto('/?demo=1');
  const title = page.getByRole('button', { name: 'Выбрать вариант экрана оплаты' });
  await title.click();
  let dialog = page.getByRole('dialog', { name: 'DEMO-101', exact: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(title).toBeFocused();
  await title.click();
  dialog = page.getByRole('dialog', { name: 'DEMO-101', exact: true });
  await dialog.getByRole('button', { name: 'Решение принято' }).click();
  await expect(dialog.getByText('Действие выполнено.', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Завершить работу' }).click();
  await expect(dialog.getByRole('button', { name: 'Вернуть в работу' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Вернуть в работу' }).click();
  await expect(dialog.getByRole('button', { name: 'Завершить работу' })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(title).toBeFocused();
});

test('track dialog validates IDs and does not invent Asana metadata', async ({ page }) => {
  await page.goto('/?demo=1');
  await page.getByRole('button', { name: 'Отслеживать задачу', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Отслеживать задачу' });
  await dialog.getByLabel('ID задачи Asana').fill('not-an-id');
  await expect(dialog.getByRole('button', { name: 'Добавить на доску' })).toBeDisabled();
  await dialog.getByLabel('ID задачи Asana').fill('99999');
  await dialog.getByRole('button', { name: 'Добавить на доску' }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: 'Задача 99999', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('Недоступны', { exact: true })).toBeVisible();
});

test('stop requires confirmation and disables further writes', async ({ page }) => {
  await page.goto('/?demo=1');
  await page.getByRole('button', { name: 'Остановить сервис', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Остановить сервис?' });
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  await expect(page.getByRole('heading', { name: 'Сервис остановлен' })).not.toBeVisible();
  await page.getByRole('button', { name: 'Остановить сервис', exact: true }).click();
  await dialog.getByRole('button', { name: 'Остановить сервис', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Сервис остановлен' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Отслеживать задачу' })).toBeDisabled();
});

test('WebSocket invalidation reloads source projection', async ({ page }) => {
  const { board, sockets } = await service(page);
  await page.goto('/');
  await expect(page.getByText('На связи', { exact: true })).toBeVisible();
  board.items[0].title = 'Изменено в сервисе'; board.cursor = 'next';
  sockets.at(-1)!.send(JSON.stringify({ type: 'board.invalidated', cursor: 'next' }));
  await expect(page.getByRole('button', { name: 'Изменено в сервисе' })).toBeVisible();
  await expect(page.getByText('Данные примера.', { exact: true })).not.toBeVisible();
});

test('conflict is shown inside the dialog without resending the action', async ({ page }) => {
  await service(page);
  let posts = 0;
  await page.route('**/api/v1/commands', async (route) => {
    posts++;
    expect(route.request().headers()['x-csrf-token']).toBe('demo-only');
    expect(route.request().postDataJSON()).toMatchObject({ work_item_id: '101', expected_revision: 1 });
    await route.fulfill({ status: 409 });
  });
  await expectSingleCommandResult(page, /Состояние изменилось/, () => posts);
});

test('lost command response is reconciled by ID, not repeated or called completed', async ({ page }) => {
  await service(page);
  let posts = 0;
  let id = '';
  await page.route('**/api/v1/commands', async (route) => {
    posts++; id = String(route.request().postDataJSON().request_id);
    await route.abort('connectionfailed');
  });
  await page.route('**/api/v1/commands/*', (route) => route.fulfill({ json: { request_id: id, status: 'queued' } }));
  await expectSingleCommandResult(page, /Запрос в очереди/, () => posts);
});

test('malformed API and authorization failures never silently load example data', async ({ page }) => {
  await page.route('**/api/v1/board', (route) => route.fulfill({ json: { schema: 'unknown' } }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Не удалось прочитать доску' })).toBeVisible();
  await expect(page.getByText('Данные примера.', { exact: true })).not.toBeVisible();
  await page.route('**/api/v1/board', (route) => route.fulfill({ status: 401 }));
  await page.getByRole('button', { name: 'Повторить' }).click();
  await expect(page.getByRole('heading', { name: 'Нужно подключение к сервису' })).toBeVisible();
});

test('source text stays text and theme changes work', async ({ page }) => {
  const { board } = await service(page);
  board.items[0].title = '<img src=x onerror=alert(1)>';
  await page.goto('/');
  await expect(page.getByRole('button', { name: board.items[0].title })).toBeVisible();
  await expect(page.locator('img')).toHaveCount(0);
  await page.getByRole('button', { name: 'Тема: системная' }).click();
  await page.getByRole('button', { name: 'Тема: светлая' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
});

test('system theme follows preference changes until explicitly overridden', async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/?demo=1');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Выбрать вариант экрана оплаты' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('board-dark.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Тема: системная' }).click();
  await page.getByRole('button', { name: 'Тема: светлая' }).click();
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('tracking uses friendly source criteria rather than a task GID input', async ({page}) => {
  const {board}=await service(page);board.capabilities.track=false;
  const rule:{preset:string;choices:string[]}={preset:'current_work',choices:[]};
  const writes:unknown[]=[];
  await page.route('**/api/v1/tracking',async route=>{
    if(route.request().method()==='PUT'){
      const next=route.request().postDataJSON();writes.push(next);Object.assign(rule,next);
      await route.fulfill({json:{saved:true}});return;
    }
    await route.fulfill({json:{state:'connected',candidates:20,tracked:2,truncated:false,rule,csrf_token:'fixture-csrf',choices:[{id:'section:111',label:'In Progress',group:'Example project',count:2}],subscriptions:{resources:2,event_responses:3,event_changes:0,synced:2,retrying:0,owners:[]}}});
  });
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Моя текущая работа'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Отслеживать задачу',exact:true})).toHaveCount(0);
  await page.getByText('Настроить реальные секции и поля Asana').click();
  await page.getByRole('checkbox',{name:'In Progress'}).check();
  await expect(page.getByRole('checkbox',{name:'In Progress'})).toBeChecked();
  expect(writes).toContainEqual({preset:'custom',choices:['section:111']});
});

test('dependency view uses the reusable websocket graph API and renders arrows', async ({page})=>{
  await page.routeWebSocket('**/api/v1/views/events',socket=>{
    socket.onMessage(message=>{
      const request=JSON.parse(String(message));
      if(request.type==='watch.graph')socket.send(JSON.stringify({type:'graph.snapshot',root:'111',nodes:[{id:'111',title:'First work item',completed:false},{id:'222',title:'Prerequisite',completed:false}],edges:[{from:'111',to:'222'}],truncated:false,resources:['111','222']}));
    });
  });
  await page.goto('/?view=dependencies&task=111');
  await expect(page.getByRole('heading',{name:'Граф зависимостей'})).toBeVisible();
  await expect(page.getByRole('img',{name:'Граф: стрелка ведёт от задачи к её зависимости'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Prerequisite'})).toBeVisible();
});

test('saved work appears after reload and a human can claim and complete its continuation', async ({page}) => {
  const {board} = await service(page); const first = board.items[0]!; first.id = '111';
  const items: import('@asana-cli/service-client/workflow').Work[] = [];
  await page.route('**/api/v1/tracking', route => route.fulfill({json:{state:'connected',candidates:1,tracked:1,truncated:false,rule:{preset:'current_work',choices:[]},csrf_token:board.csrf_token,choices:[],subscriptions:{resources:1,event_responses:1,event_changes:0,synced:1,retrying:0,owners:[]}}}));
  await page.route('**/api/v1/work', async route => {
    if (route.request().method() === 'GET') return route.fulfill({json:{items,lease_ms:90000}});
    expect(route.request().headers()['x-csrf-token']).toBe(board.csrf_token);
    const input = route.request().postDataJSON(); const at = new Date().toISOString();
    items.push({id:input.request_id,revision:1,task_gid:input.task_gid,title:first.title!,status:'waiting',condition:input.condition,checkpoint:input.checkpoint,created_at:at,updated_at:at});
    return route.fulfill({status:201,json:items[0]});
  });
  await page.route('**/api/v1/work/*/actions', async route => {
    const action = route.request().postDataJSON(); const work = items[0]!;
    expect(action.expected_revision).toBe(work.revision); work.revision++;
    if (action.kind === 'claim') { work.status='running'; work.run={worker:action.worker,started_at:new Date().toISOString(),expires_at:new Date(Date.now()+90000).toISOString()}; }
    else { expect(action.kind).toBe('complete'); work.status='completed'; work.run!.report=action.summary; }
    return route.fulfill({json:work});
  });
  await page.goto('/'); await page.getByRole('button',{name:first.title!,exact:true}).click();
  await page.getByText('Сохранить работу и дождаться изменения',{exact:true}).click();
  await page.getByLabel('Что уже сделано',{exact:true}).fill('Подготовлено исправление');
  await page.getByLabel('Что сделать после ожидания',{exact:true}).fill('Проверить итог тестирования');
  await page.getByRole('button',{name:'Сохранить ожидание',exact:true}).click();
  await expect(page.getByText('Ожидание сохранено.',{exact:false})).toBeVisible();
  await page.reload(); await expect(page.getByRole('heading',{name:'Работа и продолжения'})).toBeVisible();
  await expect(page.getByText('Ожидает Asana',{exact:true})).toBeVisible();
  items[0]!.status='ready'; items[0]!.revision=2; await page.reload();
  await page.getByRole('button',{name:'Продолжить в этом окне',exact:true}).click();
  await page.getByLabel('Результат или ход работы',{exact:true}).fill('Результат проверен');
  await page.getByRole('button',{name:'Завершить продолжение',exact:true}).click();
  await expect(page.getByText('Продолжение завершено',{exact:true})).toBeVisible();
});
