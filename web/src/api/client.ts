import {
  boardSchema, commandSchema, eventSchema, receiptSchema,
  type BoardCommand, type BoardEvent, type BoardSnapshot, type CommandReceipt,
} from '../model/board';

export interface BoardClient {
  readonly mode: 'service' | 'demo';
  loadBoard(signal?: AbortSignal): Promise<BoardSnapshot>;
  sendCommand(command: BoardCommand, csrf: string): Promise<CommandReceipt>;
  getCommand(requestId: string): Promise<CommandReceipt>;
  subscribe(cursor: string, handlers: StreamHandlers): () => void;
}
export interface StreamHandlers {
  open(): void;
  event(event: BoardEvent): void;
  close(reason: 'offline' | 'unauthorized' | 'invalid_response'): void;
}
export class ApiError extends Error {
  constructor(readonly kind: 'offline' | 'unauthorized' | 'conflict' | 'invalid_response' | 'rejected') {
    super(kind);
  }
}

function checkSize(size: number): void {
  if (size > 1_048_576) throw new ApiError('invalid_response');
}

async function readChunks(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    checkSize(size);
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new ApiError('invalid_response');
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readChunks(reader))) as unknown;
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new ApiError('invalid_response');
  } finally { reader.releaseLock(); }
}

function requestSignal(signal: RequestInit['signal']) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = setTimeout(abort, 10_000);
  return { signal: controller.signal,
    dispose() { clearTimeout(timeout); signal?.removeEventListener('abort', abort); } };
}
function checkStatus(response: Response): void {
  if ([401, 403].includes(response.status)) throw new ApiError('unauthorized');
  if (response.status === 409) throw new ApiError('conflict');
  if (!response.ok) throw new ApiError('rejected');
}
async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const lifetime = requestSignal(init.signal);
  try {
    const response = await fetch(path, { ...init, signal: lifetime.signal, credentials: 'same-origin',
      headers: { Accept: 'application/json', ...init.headers } });
    if (response.status >= 500) throw new ApiError('offline');
    checkStatus(response);
    return await readJson(response);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('offline');
  } finally { lifetime.dispose(); }
}

function parsed<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError('invalid_response');
  return result.data;
}

function subscribe(cursor: string, handlers: StreamHandlers): () => void {
  const url = new URL('/api/v1/events', window.location.href);
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('cursor', cursor);
  const socket = new WebSocket(url);
  let disposed = false;
  let reason: Parameters<StreamHandlers['close']>[0] = 'offline';
  socket.onopen = () => { if (!disposed) handlers.open(); };
  socket.onmessage = (message) => {
    if (disposed) return;
    try {
      handlers.event(readEvent(message.data));
    } catch { reason = 'invalid_response'; socket.close(); }
  };
  socket.onclose = (event) => {
    if (!disposed) handlers.close(event.code === 4401 ? 'unauthorized' : reason);
  };
  return () => { disposed = true; socket.close(); };
}

function readEvent(data: unknown): BoardEvent {
  if (typeof data !== 'string' || data.length > 65_536) throw new ApiError('invalid_response');
  return parsed(eventSchema, JSON.parse(data) as unknown);
}

export function createHttpClient(): BoardClient {
  return {
    mode: 'service',
    async loadBoard(signal) { return parsed(boardSchema, await request('/api/v1/board', { signal })); },
    async sendCommand(command, csrf) {
      const input = commandSchema.parse(command);
      const receipt = parsed(receiptSchema, await request('/api/v1/commands', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify(input),
      }));
      if (receipt.request_id !== input.request_id) throw new ApiError('invalid_response');
      return receipt;
    },
    async getCommand(requestId) {
      const receipt = parsed(receiptSchema, await request(`/api/v1/commands/${encodeURIComponent(requestId)}`));
      if (receipt.request_id !== requestId) throw new ApiError('invalid_response');
      return receipt;
    },
    subscribe,
  };
}
