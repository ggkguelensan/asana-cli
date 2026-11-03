import { useEffect, useMemo } from 'react';
import { atom, useAtom, useSetAtom } from 'jotai';
import { createWork } from '@asana-cli/service-client/workflow';
import { loadTracking, type TrackingStatus } from '@asana-cli/service-client';
import { workError, workRefreshAtom } from './state';

export function WaitForm({ taskId }: { taskId: string }) {
  const state = useMemo(() => atom({ summary: '', next: '', condition: 'completed', requestId: crypto.randomUUID(), busy: false, error: '', saved: false }), [taskId]);
  const source = useMemo(() => atom<TrackingStatus|null>(null), [taskId]);
  const [draft, setDraft] = useAtom(state); const [tracking, setTracking] = useAtom(source); const refresh = useSetAtom(workRefreshAtom);
  useEffect(() => { const abort = new AbortController(); void loadTracking(abort.signal).then(setTracking).catch(() => {}); return () => abort.abort(); }, [taskId]);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (!tracking) return;
    setDraft(value => ({ ...value, busy: true, error: '' }));
    try {
      const condition = draft.condition === 'completed' ? { kind: 'completed' as const } : { kind: 'choice' as const, choice_id: draft.condition };
      await createWork({ request_id: draft.requestId, task_gid: taskId, condition, checkpoint: { summary: draft.summary, next: draft.next } }, tracking.csrf_token);
      refresh(value => value + 1); setDraft(value => ({ ...value, saved: true }));
    } catch (error) { setDraft(value => ({ ...value, error: workError(error) })); }
    finally { setDraft(value => ({ ...value, busy: false })); }
  }
  if (!tracking) return null;
  if (draft.saved) return <p role="status">Ожидание сохранено. Оно продолжит работать после закрытия страницы.</p>;
  return <details className="detail-section"><summary>Сохранить работу и дождаться изменения</summary>
    <form className="work-form" onSubmit={event => void submit(event)}>
      <label>Что уже сделано<textarea required maxLength={4000} value={draft.summary} onChange={event => setDraft({ ...draft, summary: event.target.value, requestId: crypto.randomUUID() })}/></label>
      <label>Что сделать после ожидания<textarea required maxLength={4000} value={draft.next} onChange={event => setDraft({ ...draft, next: event.target.value, requestId: crypto.randomUUID() })}/></label>
      <label>Продолжить, когда<select value={draft.condition} onChange={event => setDraft({ ...draft, condition: event.target.value, requestId: crypto.randomUUID() })}>
        <option value="completed">Задача завершена в Asana</option>
        {tracking.choices.map(choice => <option key={choice.id} value={choice.id}>{choice.group} — {choice.label}</option>)}
      </select></label>
      <p className="muted">Признаки взяты из обнаруженных задач. Это ожидание конкретного значения, а не подтверждение QA для определённой сборки. Автозапуск агента не включается.</p>
      {draft.error && <p role="alert">{draft.error}</p>}
      <button className="button button-primary" disabled={draft.busy}>Сохранить ожидание</button>
    </form>
  </details>;
}
