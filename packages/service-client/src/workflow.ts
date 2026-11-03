import { createWorkSchema, workActionSchema, workSchema, workListSchema, type CreateWork, type WorkAction } from '@asana-cli/core/workflow';
export { type Work, type CreateWork, type WorkAction } from '@asana-cli/core/workflow';
export class WorkRequestError extends Error {
  constructor(readonly code: string) { super(code); }
}
async function response(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  if (!response.ok) throw new WorkRequestError(errorCode(body));
  return body;
}
function errorCode(body: unknown): string {
  if (typeof body !== 'object' || body === null) return 'request_failed';
  return 'error' in body ? String(body.error) : 'request_failed';
}
export async function loadWork(signal?: AbortSignal) {
  return workListSchema.parse(await response(await fetch('/api/v1/work', { credentials: 'same-origin', signal })));
}
async function post(path: string, body: unknown, csrf: string) {
  return response(await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) }));
}
export async function createWork(input: CreateWork, csrf: string) {
  return workSchema.parse(await post('/api/v1/work', createWorkSchema.parse(input), csrf));
}
export async function actOnWork(id: string, action: WorkAction, csrf: string) {
  return workSchema.parse(await post(`/api/v1/work/${encodeURIComponent(id)}/actions`, workActionSchema.parse(action), csrf));
}
