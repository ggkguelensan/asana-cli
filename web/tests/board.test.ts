import { describe, expect, mock, test } from 'bun:test';
import { createStore } from 'jotai/vanilla';
import { exampleBoard } from '../src/api/demo-data';
import { createDemoClient } from '../src/api/demo-client';
import { ApiError, type BoardClient, type StreamHandlers } from '../src/api/client';
import { boardSchema, type BoardCommand, type CommandReceipt } from '../src/model/board';
import { boardAtom, connectionAtom, countsAtom, filteredItemsAtom, kindAtom, noticeAtom,
  searchAtom, sectionsAtom, selectedIdAtom, selectedItemAtom } from '../src/state/atoms';
import { createBoardController } from '../src/state/controller';
import { connectBoard } from '../src/state/connection';

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error('Expected state was not reached');
}
function fixture() {
  const streams: StreamHandlers[] = [];
  const close = mock(() => undefined);
  const client = {
    mode: 'service' as const,
    loadBoard: mock(async () => exampleBoard()),
    sendCommand: mock(async (command: BoardCommand): Promise<CommandReceipt> =>
      ({ request_id: command.request_id, status: 'completed' })),
    getCommand: mock(async (request_id: string): Promise<CommandReceipt> => ({ request_id, status: 'queued' })),
    subscribe: mock((_cursor: string, handlers: StreamHandlers) => {
      streams.push(handlers); handlers.open(); return close;
    }),
  } satisfies BoardClient;
  return { client, streams, close };
}

describe('board projections and disposable example', () => {
  test('filters do not alter global counters or the selected record', () => {
    const store = createStore();
    store.set(boardAtom, exampleBoard());
    store.set(selectedIdAtom, '101');
    store.set(searchAtom, 'ЭКСПОРТ');
    expect(store.get(filteredItemsAtom).map((item) => item.id)).toEqual(['102']);
    expect(store.get(countsAtom).total).toBe(8);
    expect(store.get(selectedItemAtom)?.id).toBe('101');
    store.set(searchAtom, ''); store.set(kindAtom, 'review');
    expect(store.get(filteredItemsAtom)).toHaveLength(2);
    expect(store.get(sectionsAtom).inbox).toHaveLength(1);
  });
  test('rejects duplicate IDs, unknown schema and credential-bearing source URLs', () => {
    const board = exampleBoard();
    board.items.push(board.items[0]);
    expect(boardSchema.safeParse(board).success).toBe(false);
    expect(boardSchema.safeParse({ ...exampleBoard(), schema: 'unknown' }).success).toBe(false);
    const bad = exampleBoard();
    bad.items[0].asana_url = 'https://user:secret@example.com/task';
    expect(boardSchema.safeParse(bad).success).toBe(false);
    bad.items[0].asana_url = 'javascript:alert(1)';
    expect(boardSchema.safeParse(bad).success).toBe(false);
  });
  test('demo command IDs are idempotent, revisions checked and state is not durable', async () => {
    const client = createDemoClient();
    const command: BoardCommand = { request_id: crypto.randomUUID(), kind: 'resolve_request',
      work_item_id: '101', expected_revision: 1, action_id: 'resolve', target_request_id: 'request-1' };
    await client.sendCommand(command, 'demo');
    await client.sendCommand(command, 'demo');
    expect((await client.loadBoard()).items[0].revision).toBe(2);
    await expect(client.sendCommand({ ...command, request_id: crypto.randomUUID() }, 'demo')).rejects.toMatchObject({ kind: 'conflict' });
    expect((await createDemoClient().loadBoard()).items[0].revision).toBe(1);
  });
});

describe('controller command boundary', () => {
  test('uses current server action/revision and does not optimistically complete queued work', async () => {
    const { client } = fixture();
    client.sendCommand.mockImplementation(async (command) => ({ request_id: command.request_id, status: 'queued' }));
    const store = createStore();
    const controller = createBoardController(store, client);
    const dispose = controller.connect();
    await until(() => store.get(connectionAtom) === 'live');
    await controller.runAction('101', 'resolve');
    expect(client.sendCommand.mock.calls[0][0]).toMatchObject({ expected_revision: 1, action_id: 'resolve', target_request_id: 'request-1' });
    expect(store.get(boardAtom)?.items[0].status).toBe('wait_user');
    expect(store.get(noticeAtom)?.text).toContain('ещё не выполнено');
    dispose();
  });
  test('conflict rereads state but never resends a semantic mutation', async () => {
    const { client } = fixture();
    client.sendCommand.mockRejectedValue(new ApiError('conflict'));
    const store = createStore();
    const controller = createBoardController(store, client);
    const dispose = controller.connect();
    await until(() => store.get(connectionAtom) === 'live');
    await controller.runAction('101', 'resolve');
    expect(client.sendCommand).toHaveBeenCalledTimes(1);
    expect(client.getCommand).not.toHaveBeenCalled();
    expect(client.loadBoard.mock.calls.length).toBeGreaterThan(1);
    expect(store.get(noticeAtom)?.tone).toBe('warning');
    dispose();
  });
  test('lost acknowledgement performs status lookup using the same ID without a second POST', async () => {
    const { client } = fixture();
    client.sendCommand.mockRejectedValue(new ApiError('offline'));
    const store = createStore();
    const controller = createBoardController(store, client);
    const dispose = controller.connect();
    await until(() => store.get(connectionAtom) === 'live');
    await controller.runAction('101', 'resolve');
    expect(client.sendCommand).toHaveBeenCalledTimes(1);
    expect(client.getCommand.mock.calls[0][0]).toBe(client.sendCommand.mock.calls[0][0].request_id);
    expect(store.get(noticeAtom)?.text).toContain('очереди');
    dispose();
  });
  test('unavailable receipt stays unknown and disconnected clients cannot write', async () => {
    const { client } = fixture();
    client.sendCommand.mockRejectedValue(new ApiError('offline'));
    client.getCommand.mockRejectedValue(new ApiError('offline'));
    const store = createStore();
    const controller = createBoardController(store, client);
    const dispose = controller.connect();
    await until(() => store.get(connectionAtom) === 'live');
    await controller.runAction('101', 'resolve');
    expect(store.get(noticeAtom)?.text).toContain('Результат неизвестен');
    store.set(connectionAtom, 'offline');
    await controller.runAction('101', 'resolve');
    expect(client.sendCommand).toHaveBeenCalledTimes(1);
    dispose();
  });
});

describe('connection lifecycle', () => {
  test('resync closes the expired stream and subscribes from a new snapshot cursor', async () => {
    const { client, streams, close } = fixture();
    const store = createStore();
    const connection = connectBoard(store, client);
    await until(() => store.get(connectionAtom) === 'live');
    client.loadBoard.mockResolvedValue({ ...exampleBoard(), cursor: 'resynced' });
    streams[0].event({ type: 'resync_required' });
    await until(() => client.subscribe.mock.calls.length === 2);
    expect(close).toHaveBeenCalledTimes(1);
    expect(client.subscribe.mock.calls[1][0]).toBe('resynced');
    connection.dispose();
  });
  test('WebSocket authorization loss clears the snapshot without automatic reconnect', async () => {
    const { client, streams } = fixture();
    const store = createStore();
    const connection = connectBoard(store, client);
    await until(() => store.get(connectionAtom) === 'live');
    streams[0].close('unauthorized');
    expect(store.get(boardAtom)).toBeNull();
    expect(store.get(connectionAtom)).toBe('unauthorized');
    expect(client.subscribe).toHaveBeenCalledTimes(1);
    connection.dispose();
  });
  test('disposed StrictMode mounts cannot commit late snapshots', async () => {
    const { client, close } = fixture();
    let finish!: (value: ReturnType<typeof exampleBoard>) => void;
    client.loadBoard.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const store = createStore();
    const connection = connectBoard(store, client);
    connection.dispose(); finish(exampleBoard());
    await Bun.sleep(1);
    expect(store.get(boardAtom)).toBeNull();
    expect(close).not.toHaveBeenCalled();
  });
  test('invalidations arriving during fetch cause another fetch and replacement instances resubscribe', async () => {
    const { client, streams, close } = fixture();
    const store = createStore();
    const connection = connectBoard(store, client);
    await until(() => store.get(connectionAtom) === 'live');
    let finish!: (value: ReturnType<typeof exampleBoard>) => void;
    client.loadBoard.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const loading = connection.reload();
    streams[0].event({ type: 'board.invalidated', cursor: 'next' });
    finish(exampleBoard()); await loading;
    await until(() => client.loadBoard.mock.calls.length >= 3);
    client.loadBoard.mockResolvedValue({ ...exampleBoard(), instance_id: 'replacement' });
    await connection.reload();
    expect(close).toHaveBeenCalled();
    expect(client.subscribe.mock.calls.length).toBeGreaterThan(1);
    connection.dispose();
  });
  test('revoked read clears private data and a stopping service does not retry', async () => {
    const { client, streams } = fixture();
    const store = createStore();
    const connection = connectBoard(store, client);
    await until(() => store.get(connectionAtom) === 'live');
    client.loadBoard.mockRejectedValueOnce(new ApiError('unauthorized'));
    await connection.reload();
    expect(store.get(boardAtom)).toBeNull();
    expect(store.get(connectionAtom)).toBe('unauthorized');
    await connection.reload();
    streams.at(-1)!.event({ type: 'service.stopping' });
    const count = client.loadBoard.mock.calls.length;
    await connection.reload();
    expect(client.loadBoard).toHaveBeenCalledTimes(count);
    expect(store.get(connectionAtom)).toBe('stopped');
    connection.dispose();
  });
});
