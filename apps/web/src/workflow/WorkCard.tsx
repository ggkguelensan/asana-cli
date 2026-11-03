import { useMemo } from 'react';
import { atom, useAtom, useAtomValue } from 'jotai';
import { trackingStatusAtom } from '../state/tracking';
import type { Work, WorkAction } from '@asana-cli/service-client/workflow';
const labels: Record<Work['status'],string> = { waiting: 'Ожидает Asana', ready: 'Готово к продолжению', running: 'Работа принята', interrupted: 'Исполнитель не подтвердил связь', completed: 'Продолжение завершено', cancelled: 'Отменено' };
type Action = (work: Work, action: WorkAction) => Promise<void>;
function ClosedActions({ work, act, busy }: { work: Work; act: Action; busy: boolean }) {
  if (['completed','cancelled'].includes(work.status)) return null;
  return <button className="button button-secondary" disabled={busy} onClick={() => void act(work, { kind: 'cancel', expected_revision: work.revision })}>Отменить работу</button>;
}
function ReadyActions({ work, act, busy }: { work: Work; act: Action; busy: boolean }) {
  if (work.status === 'interrupted') return <div><p>Проверьте, что прежний исполнитель остановлен и не оставил неизвестных результатов.</p><button className="button button-secondary" disabled={busy} onClick={() => void act(work, { kind: 'retry', expected_revision: work.revision })}>Повторить после проверки</button></div>;
  if (work.status !== 'ready') return null;
  return <button className="button button-primary" disabled={busy} onClick={() => void act(work, { kind: 'claim', expected_revision: work.revision, worker: 'Пользователь в браузере', lease_token: crypto.randomUUID() })}>Продолжить в этом окне</button>;
}
function RunActions({ work, token, act, busy }: { work: Work; token?: string; act: Action; busy: boolean }) {
  const reportAtom = useMemo(() => atom(''), [work.id]); const [report, setReport] = useAtom(reportAtom);
  if (!token || work.status !== 'running') return null;
  return <div className="work-form"><label>Результат или ход работы<textarea maxLength={4000} value={report} onChange={event => setReport(event.target.value)}/></label>
    <div className="detail-actions">{(['report','complete'] as const).map(kind => <button className="button button-secondary" key={kind} disabled={busy || !report.trim()} onClick={() => void act(work, { kind, expected_revision: work.revision, lease_token: token, summary: report })}>{kind === 'report' ? 'Опубликовать отчёт' : 'Завершить продолжение'}</button>)}</div>
    <p className="muted">Закрытие окна прекратит подтверждение связи. Asana этим действием не изменяется.</p>
  </div>;
}
function WaitDescription({work}:{work:Work}) {
  const tracking=useAtomValue(trackingStatusAtom);
  if(work.condition.kind==='completed')return <p><b>Условие:</b> задача завершена в Asana.</p>;
  const choiceId=work.condition.choice_id;
  const choice=tracking?.choices.find(item=>item.id===choiceId);
  return <p><b>Условие:</b> {choice ? `${choice.group} — ${choice.label}` : choiceId}</p>;
}
export function WorkCard({ work, token, act, busy }: { work: Work; token?: string; act: (work: Work, action: WorkAction) => Promise<void>; busy: boolean }) {
  return <article className="workflow-card"><p className="eyebrow">{labels[work.status]}</p><h3><a href={`https://app.asana.com/0/0/${work.task_gid}`} target="_blank" rel="noopener noreferrer">{work.title}</a></h3>
    <WaitDescription work={work}/><p><b>Сделано:</b> {work.checkpoint.summary}</p><p><b>Следующий шаг:</b> {work.checkpoint.next}</p>
    {work.evidence && <p className="muted">Условие проверено {new Date(work.evidence.observed_at).toLocaleString('ru-RU')}</p>}
    {work.run && <p><b>Исполнитель:</b> {work.run.worker}<br/>{work.run.report}</p>}
    <ReadyActions work={work} act={act} busy={busy}/><RunActions work={work} token={token} act={act} busy={busy}/><ClosedActions work={work} act={act} busy={busy}/>
  </article>;
}
