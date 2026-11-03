import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createHttpClient } from '../src/api/client';
import { exampleBoard } from '../src/api/demo-data';
import type { BoardCommand } from '../src/model/board';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('HTTP client trust boundary', () => {
  test('validates snapshots and rejects unexpected source data without returning it', async () => {
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(exampleBoard()));
    const client = createHttpClient();
    expect((await client.loadBoard()).items).toHaveLength(8);
    fetch.mockResolvedValue(Response.json({ schema: 'wrong', secret: 'PRIVATE_CANARY' }));
    await expect(client.loadBoard()).rejects.toMatchObject({ kind: 'invalid_response', message: 'invalid_response' });
  });
  test('posts one typed command with CSRF and session credentials', async () => {
    const command: BoardCommand = { kind: 'refresh_sources', request_id: crypto.randomUUID() };
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ request_id: command.request_id, status: 'accepted' }));
    const receipt = await createHttpClient().sendCommand(command, 'csrf-fixture');
    expect(receipt.status).toBe('accepted');
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'same-origin',
      headers: { 'X-CSRF-Token': 'csrf-fixture' } });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual(command);
  });
  test('rejects mismatched receipts and never exposes raw HTTP error content', async () => {
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ request_id: crypto.randomUUID(), status: 'completed' }));
    const client = createHttpClient();
    await expect(client.getCommand(crypto.randomUUID())).rejects.toMatchObject({ kind: 'invalid_response' });
    fetch.mockResolvedValue(new Response('PRIVATE_CANARY', { status: 403 }));
    await expect(client.loadBoard()).rejects.toMatchObject({ kind: 'unauthorized', message: 'unauthorized' });
  });
  test('bounds response bytes and rejects invalid JSON', async () => {
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x'.repeat(1_048_577)));
    const client = createHttpClient();
    await expect(client.loadBoard()).rejects.toMatchObject({ kind: 'invalid_response' });
    fetch.mockResolvedValue(new Response('<html>not the API</html>'));
    await expect(client.loadBoard()).rejects.toMatchObject({ kind: 'invalid_response' });
  });
});
