import { ApiError, type BoardClient, type StreamHandlers } from './client';
import { exampleBoard } from './demo-data';
import { commandSchema, type BoardCommand, type CommandReceipt, type WorkItem } from '../model/board';

type ItemCommand = Extract<BoardCommand, { work_item_id: string }>;
function currentItem(items: WorkItem[], command: ItemCommand): WorkItem {
  const item = items.find((entry) => entry.id === command.work_item_id);
  if (!item || item.revision !== command.expected_revision) throw new ApiError('conflict');
  return item;
}
function checkAction(item: WorkItem, command: ItemCommand): void {
  const action = item.actions.find((entry) => entry.id === command.action_id && entry.enabled);
  if (!action || action.kind !== command.kind) throw new ApiError('rejected');
}
function advanceExample(item: WorkItem, command: ItemCommand): void {
  checkAction(item, command);
  item.status = command.kind === 'complete_work' ? 'done' : 'work';
  item.actions = command.kind === 'complete_work'
    ? [{ id: 'reopen', kind: 'reopen_work', label: 'Вернуть в работу', enabled: true }]
    : [{ id: 'complete', kind: 'complete_work', label: 'Завершить работу', enabled: true }];
  delete item.waiting;
  item.revision += 1;
  item.updated_at = new Date().toISOString();
}

/** A disposable UI example, not the service workflow implementation. */
export function createDemoClient(): BoardClient {
  let board = exampleBoard();
  let sequence = 1;
  const subscribers = new Set<StreamHandlers>();
  const receipts = new Map<string, { payload: string; receipt: CommandReceipt }>();
  const notify = () => {
    board = { ...board, cursor: `demo-${++sequence}`, fetched_at: new Date().toISOString() };
    subscribers.forEach((listener) => listener.event({ type: 'board.invalidated', cursor: board.cursor }));
  };
  function track(taskGid: string): void {
    if (board.items.some((item) => item.id === `tracked-${taskGid}`)) return;
    if (board.items.length >= 100) throw new ApiError('rejected');
    board.items.push({ id: `tracked-${taskGid}`, key: taskGid, revision: 1,
        kind: 'task', title: null, status: 'work', owner: 'Вы', source: 'unknown',
        updated_at: new Date().toISOString(), changes: [], actions: [] });
  }
  function apply(command: BoardCommand): void {
    if (command.kind === 'track') {
      track(command.task_gid);
    } else if ('work_item_id' in command) {
      advanceExample(currentItem(board.items, command), command);
    }
    notify();
  }
  return {
    mode: 'demo',
    async loadBoard() { return structuredClone(board); },
    async sendCommand(input) {
      const command = commandSchema.parse(input);
      const previous = receipts.get(command.request_id);
      if (previous) {
        if (previous.payload !== JSON.stringify(command)) throw new ApiError('conflict');
        return previous.receipt;
      }
      apply(command);
      const receipt: CommandReceipt = { request_id: command.request_id, status: 'completed' };
      receipts.set(command.request_id, { payload: JSON.stringify(command), receipt });
      return receipt;
    },
    async getCommand(id) {
      const entry = receipts.get(id);
      if (!entry) throw new ApiError('rejected');
      return entry.receipt;
    },
    subscribe(_cursor, handlers) {
      subscribers.add(handlers);
      queueMicrotask(() => { if (subscribers.has(handlers)) handlers.open(); });
      return () => { subscribers.delete(handlers); };
    },
  };
}
