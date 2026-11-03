import { ApiError, type BoardClient } from '../api/client';
import { boardAtom, connectionAtom, type BoardStore } from './atoms';
import type { BoardSnapshot } from '../model/board';

export interface BoardConnection { reload(): Promise<void>; dispose(): void }

/** Each mount owns its requests, socket and retry timer (including React StrictMode remounts). */
export function connectBoard(store: BoardStore, client: BoardClient): BoardConnection {
  let disposed = false;
  let stopStream: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  let dirty = false;
  let attempts = 0;
  let streamLive = false;
  const abort = new AbortController();

  function retry(): void {
    if (disposed || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void reload();
    }, Math.min(1000 * 2 ** attempts++, 30_000) + Math.random() * 300);
  }
  function subscribe(cursor: string): void {
    stopStream = client.subscribe(cursor, {
      open() { if (!disposed) { attempts = 0; streamLive = true; store.set(connectionAtom, 'live'); } },
      event(event) {
        if (disposed) return;
        if (event.type === 'service.stopping') {
          store.set(connectionAtom, 'stopped');
          closeStream();
        } else {
          if (event.type === 'resync_required') closeStream();
          void reload();
        }
      },
      close(reason) {
        if (disposed) return;
        closeStream();
        if (reason === 'unauthorized') store.set(boardAtom, null);
        store.set(connectionAtom, reason);
        if (reason === 'offline') retry();
      },
    });
  }
  function closeStream(): void { stopStream?.(); stopStream = undefined; streamLive = false; }
  function active(): boolean { return !disposed && store.get(connectionAtom) !== 'stopped'; }
  function changedInstance(board: BoardSnapshot): boolean {
    const previous = store.get(boardAtom);
    return previous !== null && previous.instance_id !== board.instance_id;
  }
  function acceptBoard(board: BoardSnapshot): void {
    if (changedInstance(board)) closeStream();
    clearTimeout(timer); timer = undefined;
    store.set(boardAtom, board);
    if (!stopStream) subscribe(board.cursor);
    else if (streamLive) store.set(connectionAtom, 'live');
  }
  function failedLoad(error: unknown): void {
    const state = error instanceof ApiError ? error.kind : 'offline';
    if (state === 'unauthorized') { store.set(boardAtom, null); closeStream(); }
    if (['unauthorized', 'invalid_response'].includes(state)) {
      store.set(connectionAtom, state as 'unauthorized' | 'invalid_response');
    } else { store.set(connectionAtom, 'offline'); retry(); }
  }
  async function load(): Promise<void> {
    try {
      const board = await client.loadBoard(abort.signal);
      if (active()) acceptBoard(board);
    } catch (error) {
      if (active()) failedLoad(error);
    }
  }
  function reload(): Promise<void> {
    if (disposed || store.get(connectionAtom) === 'stopped') return Promise.resolve();
    if (pending) { dirty = true; return pending; }
    pending = load().finally(() => {
      pending = undefined;
      if (dirty && !disposed) { dirty = false; void reload(); }
    });
    return pending;
  }
  store.set(connectionAtom, store.get(boardAtom) ? 'reconnecting' : 'connecting');
  void reload();
  return {
    reload,
    dispose() { disposed = true; abort.abort(); clearTimeout(timer); stopStream?.(); },
  };
}
