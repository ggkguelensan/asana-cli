import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InterestRegistry, taskSchema } from '@asana-cli/core';
import { createWorkSchema, workSchema } from '@asana-cli/core/workflow';
import { runService, type TaskSource } from '../src';
import { openStore } from '../src/store';
import { Workflow } from '../src/workflow';

const input = () => createWorkSchema.parse({ request_id: crypto.randomUUID(), task_gid: '222', condition: { kind: 'completed' }, checkpoint: { summary: 'Change prepared', next: 'Read QA result before continuing' } });
const task = (completed = false) => taskSchema.parse({ gid: '222', name: 'Fixture task', completed });
const now = '2026-11-03T10:00:00.000Z';

test('workflow survives v1 migration/restart, owns an unassigned resource and queues exactly one continuation from Events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'asana-work-'));
  const old = new Database(join(root, 'state.sqlite')); old.exec("CREATE TABLE settings (key text PRIMARY KEY, value text NOT NULL); INSERT INTO settings VALUES ('tracking_rule','{\"preset\":\"all_incomplete\",\"choices\":[]}'); PRAGMA user_version=1"); old.close();
  let completed = false;
  const source: TaskSource = { identity: async () => ({ gid: '1', name: 'Fixture', workspaces: [] }), assigned: async () => ({ tasks: [], truncated: false }), task: async () => task(completed), events: async () => ({ sync: 's', changed: true, more: false }) };
  let service = await runService({ stateDirectory: root, pat: 'FIXTURE', source });
  const post = (path: string, value: unknown) => fetch(service.descriptor.origin + path, { method: 'POST', headers: { Authorization: `Bearer ${service.descriptor.nativeToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  try {
    const request = input();
    expect(service.engine.rule.preset).toBe('all_incomplete');
    const created = await post('/api/v1/work', request); expect(created.status).toBe(201);
    const work = workSchema.parse(await created.json()); expect(work.status).toBe('waiting');
    expect((await post('/api/v1/work', request)).status).toBe(200);
    expect((await post('/api/v1/work', { ...request, checkpoint: { ...request.checkpoint, next: 'Different intent' } })).status).toBe(409);
    expect(service.engine.interests.resources()).toEqual(['222']);
    await service.stop();
    service = await runService({ stateDirectory: root, pat: 'FIXTURE', source });
    expect(service.engine.interests.resources()).toEqual(['222']);
    completed = true; await service.engine.refresh(); await service.engine.tick();
    const ready = service.workflow.list().items[0]!; expect(ready.status).toBe('ready'); expect(ready.revision).toBe(2);
    service.workflow.observe(task(true), now); expect(service.workflow.list().items).toHaveLength(1); expect(service.workflow.list().items[0]!.revision).toBe(2);
    completed = false;
    expect((await post(`/api/v1/work/${work.id}/actions`, { kind: 'claim', expected_revision: ready.revision, worker: 'fixture', lease_token: crypto.randomUUID() })).status).toBe(409);
    expect(service.workflow.list().items[0]!.status).toBe('waiting');
    expect((await post('/api/v1/work', { ...input(), condition: { kind: 'choice', choice_id: 'unsafe' } })).status).toBe(422);
  } finally { await service.stop(); await rm(root, { recursive: true, force: true }); }
});

test('claim is fenced by revision/token; expired accepted work is interrupted and only an explicit retry requeues it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'asana-work-lease-')); const store = openStore(root);
  const interests = new InterestRegistry(); const workflow = new Workflow(store.work, interests, () => {});
  try {
    expect(() => workflow.create(input(), task(true), now)).toThrow('condition_already_met');
    const created = workflow.create(input(), task(), now);
    workflow.observe(task(true), now); const ready = workflow.get(created.id);
    const token = crypto.randomUUID(); const claim = { kind: 'claim' as const, expected_revision: ready.revision, worker: 'fixture-worker', lease_token: token };
    const running = workflow.claim(ready.id, claim, task(true), now);
    expect(() => workflow.claim(ready.id, claim, task(true), now)).toThrow('revision_conflict');
    expect(JSON.stringify(workflow.list())).not.toContain('lease_hash');
    expect(() => workflow.act(ready.id, { kind: 'complete', expected_revision: running.revision, lease_token: crypto.randomUUID(), summary: 'Wrong worker' }, now)).toThrow('lease_mismatch');
    const reported = workflow.act(ready.id, { kind: 'report', expected_revision: running.revision, lease_token: token, summary: 'Checking result' }, now);
    const late = '2026-11-03T10:02:00.000Z';
    expect(() => workflow.act(ready.id, { kind: 'complete', expected_revision: reported.revision, lease_token: token, summary: 'Late result' }, late)).toThrow('lease_expired');
    workflow.expire(late); const interrupted = workflow.get(ready.id); expect(interrupted.status).toBe('interrupted');
    const retry = workflow.act(ready.id, { kind: 'retry', expected_revision: interrupted.revision }, late);
    const second = workflow.claim(ready.id, { ...claim, expected_revision: retry.revision, lease_token: crypto.randomUUID() }, task(true), late);
    const cancelled = workflow.act(ready.id, { kind: 'cancel', expected_revision: second.revision }, late);
    expect(cancelled.status).toBe('cancelled'); expect(interests.resources()).toEqual([]);
    expect(() => workflow.act(ready.id, { kind: 'complete', expected_revision: second.revision, lease_token: token, summary: 'Stale' }, late)).toThrow('revision_conflict');
    const anotherInput = input(); const another = workflow.create(anotherInput, task(), late);
    workflow.observe(task(true), late); const next = workflow.get(another.id); const nextToken = crypto.randomUUID();
    const accepted = workflow.claim(next.id, { ...claim, expected_revision: next.revision, lease_token: nextToken }, task(true), late);
    const heartbeat = workflow.act(next.id, { kind: 'heartbeat', expected_revision: accepted.revision, lease_token: nextToken }, '2026-11-03T10:02:30.000Z');
    expect(heartbeat.run!.expires_at).toBe('2026-11-03T10:04:00.000Z');
    const finished = workflow.act(next.id, { kind: 'complete', expected_revision: heartbeat.revision, lease_token: nextToken, summary: 'Verified outcome' }, '2026-11-03T10:03:00.000Z');
    expect(finished.status).toBe('completed'); expect(interests.resources()).toEqual([]);
    expect(workflow.create(anotherInput, task(true), late).status).toBe('completed');

  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
