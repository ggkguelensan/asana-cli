import { ApiError, type BoardClient } from '../api/client';
import type { BoardCommand, CommandReceipt } from '../model/board';
import { boardAtom, connectedAtom, connectionAtom, noticeAtom, pendingAtom,
  stopDialogAtom, trackDialogAtom, trackInputAtom, type BoardStore } from './atoms';
import { connectBoard, type BoardConnection } from './connection';

export interface BoardController {
  readonly mode: BoardClient['mode'];
  connect(): () => void;
  refresh(): Promise<void>;
  refreshSources(): Promise<void>;
  runAction(itemId: string, actionId: string): Promise<void>;
  track(): Promise<void>;
  stop(): Promise<void>;
}

export function createBoardController(store: BoardStore, client: BoardClient): BoardController {
  let connection: BoardConnection | undefined;
  function showReceipt(receipt: CommandReceipt): void {
    const messages: Record<CommandReceipt['status'], string> = {
      queued: 'Запрос в очереди. Действие ещё не выполнено.',
      accepted: 'Запрос принят. Ожидаем результат.', completed: 'Действие выполнено.',
      failed: 'Действие не выполнено. Проверьте состояние задачи.',
      unknown: 'Результат неизвестен. Не повторяйте действие до проверки.',
    };
    store.set(noticeAtom, { tone: receipt.status === 'completed' ? 'success' : 'warning',
      text: messages[receipt.status] });
  }
  async function reconcile(command: BoardCommand, error: unknown): Promise<CommandReceipt | null> {
    if (!(error instanceof ApiError)) return lookup(command);
    if (error.kind === 'conflict') {
      store.set(noticeAtom, { tone: 'warning', text: 'Состояние изменилось. Доска обновлена; проверьте действие ещё раз.' });
      return null;
    }
    if (['unauthorized', 'rejected'].includes(error.kind)) {
      showDenial(error.kind);
      return null;
    }
    return lookup(command);
  }
  function showDenial(kind: string): void {
    store.set(noticeAtom, { tone: 'error', text: kind === 'unauthorized'
      ? 'Нет доступа к действию. Проверьте подключение сервиса.' : 'Сервис отклонил действие.' });
  }
  async function lookup(command: BoardCommand): Promise<CommandReceipt> {
    try { return await client.getCommand(command.request_id); }
    catch { return { request_id: command.request_id, status: 'unknown' }; }
  }
  function canSend(key: string): boolean {
    return store.get(boardAtom) !== null && store.get(connectedAtom) && !store.get(pendingAtom).includes(key);
  }
  function completeReceipt(receipt: CommandReceipt, command: BoardCommand): void {
    showReceipt(receipt);
    if (receipt.status !== 'completed') return;
    switch (command.kind) {
      case 'service_stop': stopLocally(); break;
      case 'track': store.set(trackDialogAtom, false); store.set(trackInputAtom, ''); break;
    }
  }
  function stopLocally(): void {
    connection?.dispose(); store.set(connectionAtom, 'stopped');
  }
  async function send(key: string, command: BoardCommand): Promise<void> {
    if (!canSend(key)) return;
    const board = store.get(boardAtom)!;
    store.set(pendingAtom, (keys) => [...keys, key]);
    store.set(noticeAtom, null);
    try {
      const receipt = await client.sendCommand(command, board.csrf_token)
        .catch((error: unknown) => reconcile(command, error));
      if (receipt) completeReceipt(receipt, command);
      await connection?.reload();
    } finally { store.set(pendingAtom, (keys) => keys.filter((entry) => entry !== key)); }
  }
  const requestId = () => crypto.randomUUID();
  return {
    mode: client.mode,
    connect() {
      connection?.dispose();
      const current = connectBoard(store, client);
      connection = current;
      return () => { current.dispose(); if (connection === current) connection = undefined; };
    },
    async refresh() { await connection?.reload(); },
    async refreshSources() {
      if (store.get(boardAtom)?.capabilities.refresh) {
        await send('refresh', { kind: 'refresh_sources', request_id: requestId() });
      }
    },
    async runAction(itemId, actionId) {
      const item = store.get(boardAtom)?.items.find((entry) => entry.id === itemId);
      const action = item?.actions.find((entry) => entry.id === actionId && entry.enabled);
      if (!item || !action) return;
      await send(item.id, { kind: action.kind, request_id: requestId(), work_item_id: item.id,
        expected_revision: item.revision, action_id: action.id, target_request_id: action.request_id });
    },
    async track() {
      const gid = store.get(trackInputAtom).trim();
      if (!/^\d{1,32}$/.test(gid) || !store.get(boardAtom)?.capabilities.track) return;
      await send('track', { kind: 'track', request_id: requestId(), task_gid: gid });
    },
    async stop() {
      store.set(stopDialogAtom, false);
      if (store.get(boardAtom)?.capabilities.stop) {
        await send('stop', { kind: 'service_stop', request_id: requestId() });
      }
    },
  };
}
