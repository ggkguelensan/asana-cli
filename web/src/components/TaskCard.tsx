import { useSetAtom } from 'jotai';
import type { WorkItem } from '../model/board';
import { selectedIdAtom } from '../state/atoms';
import { ChangeLinks } from './ChangeLinks';
import { StatusBadge } from './StatusBadge';
import { Icon } from './Icon';

function SourceFreshness({ source }: { source: WorkItem['source'] }) {
  if (source === 'fresh') return null;
  const labels = { stale: 'Данные Asana устарели', unknown: 'Данные Asana недоступны' };
  return <span className="freshness"><Icon name="clock" />{labels[source]}</span>;
}
function CardIdentity({ item }: { item: WorkItem }) {
  return <div className="card-topline"><span className="task-key">{item.key}</span>
    {item.kind === 'review' && <span className="kind-label">ревью</span>}
    <StatusBadge status={item.status} className="card-badge" /></div>;
}
function CardNotes({ item }: { item: WorkItem }) {
  return <>{item.waiting && <p className={`card-waiting ${item.status === 'wait_user' ? 'waiting-user' : ''}`}>{item.waiting}</p>}
    {item.next && <p className="card-next"><span>Дальше</span>{item.next}</p>}</>;
}
function CardFooter({ item }: { item: WorkItem }) {
  const time = new Date(item.updated_at);
  return <footer className="card-footer">
    <span className="owner"><span className="avatar" aria-hidden="true">{item.owner.slice(0, 1)}</span>{item.owner}</span>
    {item.session?.online && <span className="session-dot" title={`На связи: ${item.session.name}`} />}
    <time dateTime={item.updated_at} title={time.toLocaleString('ru-RU')}>
      {time.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</time>
  </footer>;
}
export function TaskCard({ item }: { item: WorkItem }) {
  const select = useSetAtom(selectedIdAtom);
  return <article className={`task-card card-${item.status}`}>
    <CardIdentity item={item} />
    <h3 className="card-heading"><button id={`work-title-${item.id}`} onClick={() => select(item.id)}>
      {item.title ?? `Задача ${item.key}`}<Icon name="arrow" /></button></h3>
    <CardNotes item={item} /><ChangeLinks changes={item.changes} />
    <SourceFreshness source={item.source} /><CardFooter item={item} />
  </article>;
}
