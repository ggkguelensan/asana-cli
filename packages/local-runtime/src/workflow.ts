import { createHash } from 'node:crypto';
import { conditionMet, nextWaitStatus, activeWork, workSchema, WorkflowError, type CreateWork, type WorkAction, type Work } from '@asana-cli/core/workflow';
import type { SourceTask, InterestRegistry } from '@asana-cli/core';
import type { WorkRepository, StoredWork } from './work-repository';
const leaseMs = 90_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const owner = (id: string) => `workflow:${id}`;

export class Workflow {
  private closed = false;
  constructor(private repository: WorkRepository, private interests: InterestRegistry, private changed: () => void) {
    this.repository.list().forEach(work => this.interest(work));
  }
  stop() { this.closed = true; }
  list() { return { items: this.repository.list().map(work => workSchema.parse(work)), lease_ms: leaseMs }; }
  get(id: string): StoredWork {
    const work = this.repository.get(id);
    if (!work) throw new WorkflowError('work_not_found', 404);
    return work;
  }
  existing(input: CreateWork): StoredWork | undefined {
    const work = this.repository.get(input.request_id);
    if (work && work.input_hash !== hash(JSON.stringify(input))) throw new WorkflowError('request_id_reused');
    return work;
  }
  create(input: CreateWork, task: SourceTask, now: string): StoredWork {
    const existing = this.existing(input); if (existing) return existing;
    if (this.repository.list().length >= 500) throw new WorkflowError('work_limit', 422);
    if (conditionMet(task, input.condition)) throw new WorkflowError('condition_already_met');
    const work: StoredWork = { id: input.request_id, revision: 1, task_gid: input.task_gid, title: task.name,
      status: 'waiting', condition: input.condition, checkpoint: input.checkpoint,
      created_at: now, updated_at: now, input_hash: hash(JSON.stringify(input)) };
    this.repository.insert(work); this.interest(work); this.changed(); return work;
  }
  observe(task: SourceTask, now: string): void {
    if (this.closed) return;
    this.repository.list().filter(work => work.task_gid === task.gid).forEach(work => this.observed(work, task, now));
  }
  private observed(work: StoredWork, task: SourceTask, now: string) {
    const status = nextWaitStatus(work, task); if (status === work.status) return;
    const evidence = status === 'ready' ? { observed_at: now, modified_at: task.modified_at } : undefined;
    this.save({ ...work, status, evidence }, now);
  }
  expire(now: string): void {
    if (this.closed) return;
    this.repository.list().filter(work => this.expired(work, now)).forEach(work => this.save({ ...work, status: 'interrupted', lease_hash: undefined }, now));
  }
  private expired(work: StoredWork, now: string): boolean { return work.status === 'running' && work.run!.expires_at <= now; }
  private version(id: string, action: WorkAction): StoredWork {
    const work = this.get(id);
    if (work.revision !== action.expected_revision) throw new WorkflowError('revision_conflict');
    return work;
  }
  claim(id: string, action: Extract<WorkAction, {kind:'claim'}>, task: SourceTask, now: string): StoredWork {
    const work = this.version(id, action);
    if (work.status !== 'ready') throw new WorkflowError('work_not_ready');
    if (!conditionMet(task, work.condition)) {
      this.save({ ...work, status: 'waiting', evidence: undefined }, now);
      throw new WorkflowError('condition_changed');
    }
    return this.save({ ...work, status: 'running', lease_hash: hash(action.lease_token),
      run: { worker: action.worker, started_at: now, expires_at: this.deadline(now) } }, now);
  }
  act(id: string, action: Exclude<WorkAction, {kind:'claim'}>, now: string): StoredWork {
    const work = this.version(id, action);
    if (action.kind === 'cancel') return this.cancel(work, now);
    if (action.kind === 'retry') return this.retry(work, now);
    this.authorize(work, action.lease_token, now);
    if (action.kind === 'complete') return this.save({ ...work, status: 'completed', lease_hash: undefined,
      run: { ...work.run!, report: action.summary } }, now);
    const report = this.report(action, work);
    return this.save({ ...work, run: { ...work.run!, expires_at: this.deadline(now), report } }, now);
  }
  private report(action: WorkAction, work: StoredWork) { return action.kind === 'report' ? action.summary : work.run!.report; }
  private cancel(work: StoredWork, now: string) {
    if (!activeWork(work)) throw new WorkflowError('work_closed');
    return this.save({ ...work, status: 'cancelled', lease_hash: undefined }, now);
  }
  private retry(work: StoredWork, now: string) {
    if (work.status !== 'interrupted') throw new WorkflowError('work_not_interrupted');
    return this.save({ ...work, status: 'ready', run: undefined, lease_hash: undefined }, now);
  }
  private authorize(work: StoredWork, token: string, now: string) {
    if (work.status !== 'running') throw new WorkflowError('work_not_running');
    if (work.lease_hash !== hash(token)) throw new WorkflowError('lease_mismatch');
    if (this.expired(work, now)) throw new WorkflowError('lease_expired');
  }
  private deadline(now: string) { return new Date(Date.parse(now) + leaseMs).toISOString(); }
  private interest(work: Work) {
    if (activeWork(work)) this.interests.set(owner(work.id), [work.task_gid]);
    else this.interests.release(owner(work.id));
  }
  private save(work: StoredWork, now: string): StoredWork {
    const next = { ...work, revision: work.revision + 1, updated_at: now };
    this.repository.replace(next, work.revision); this.interest(next); this.changed(); return next;
  }
}
