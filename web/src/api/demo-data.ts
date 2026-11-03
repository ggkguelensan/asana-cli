import { boardSchema, type BoardSnapshot, type WorkItem, type WorkAction } from '../model/board';

const resolve: WorkAction = { id: 'resolve', kind: 'resolve_request', label: 'Решение принято',
  enabled: true, request_id: 'request-1' };
const complete: WorkAction = { id: 'complete', kind: 'complete_work', label: 'Завершить работу', enabled: true };
const reopen: WorkAction = { id: 'reopen', kind: 'reopen_work', label: 'Вернуть в работу', enabled: true };

export function exampleBoard(): BoardSnapshot {
  const now = new Date().toISOString();
  const item = (id: string, fields: Partial<WorkItem>): WorkItem => ({
    id, revision: 1, key: `DEMO-${id}`, title: null, kind: 'task', status: 'work',
    owner: 'Вы', source: 'fresh', updated_at: now, changes: [], actions: [complete], ...fields,
  });
  return boardSchema.parse({
    schema: 'asana-cli.board.v1', cursor: 'demo-1', instance_id: 'demo',
    workspace: 'Рабочее пространство', fetched_at: now, csrf_token: 'demo-only',
    capabilities: { track: true, refresh: true, stop: true },
    items: [
      item('101', { title: 'Выбрать вариант экрана оплаты', status: 'wait_user',
        waiting: 'Нужно выбрать один из двух вариантов.', next: 'Зафиксировать решение и продолжить работу.',
        actions: [resolve] }),
      item('104', { title: 'Проверить обработку ошибок', kind: 'review', status: 'wait_user',
        waiting: 'Автор ответил на замечания. Нужна повторная проверка.', next: 'Посмотреть исправления.',
        changes: [{ id: 'cr-104', label: 'MR !24', ci: 'success', merged: false, approvals: 'Ожидает ревью' }],
        actions: [{ ...resolve, label: 'Проверка завершена' }] }),
      item('102', { title: 'Добавить экспорт списка задач', next: 'Проверить формат выгрузки.',
        session: { name: 'Окно экспорта', online: true } }),
      item('103', { title: 'Обновить настройки уведомлений', status: 'blocked',
        waiting: 'Нужен доступ к тестовому workspace.', next: 'Получить доступ и проверить настройки.',
        actions: [{ ...resolve, label: 'Блокер устранён' }] }),
      item('105', { title: 'Уточнить поля отчёта', status: 'wait_others', owner: 'Анна',
        waiting: 'Ждём список обязательных полей.', next: 'Сверить поля с примером отчёта.', actions: [] }),
      item('106', { title: 'Ревью фильтрации задач', kind: 'review', status: 'reviewing',
        waiting: 'Ждём исправления автора.', next: 'Вернуться к проверке после обновления.',
        source: 'stale', actions: [],
        changes: [{ id: 'cr-106', label: 'PR #18', ci: 'running', merged: false, approvals: '2 замечания' }] }),
      item('107', { title: 'Сохранить выбранную тему', status: 'merged', actions: [complete],
        changes: [{ id: 'cr-107', label: 'PR #16', ci: 'success', merged: true }] }),
      item('108', { title: 'Исправить навигацию с клавиатуры', status: 'done', actions: [reopen] }),
    ],
  });
}
