import { useId } from 'react';
import type { WorkItem } from '../model/board';
import { TaskCard } from './TaskCard';
import { Icon } from './Icon';

function SectionHeading({ title, id, count, inbox }: { title: string; id: string; count: number; inbox: boolean }) {
  return <div className="section-heading"><h2 id={id}>{inbox && <Icon name="inbox" />}{title}</h2>
    <span className="section-count">{count}</span>
    {inbox && <span className="section-hint">Нужны ваши решения</span>}
  </div>;
}
export function BoardSection({ title, items, empty, inbox = false }:
  { title: string; items: readonly WorkItem[]; empty: string; inbox?: boolean }) {
  const id = useId();
  return <section className={`board-section ${inbox ? 'inbox-section' : ''}`} aria-labelledby={id}>
    <SectionHeading title={title} id={id} count={items.length} inbox={inbox} />
    {items.length > 0
      ? <div className="task-grid">{items.map((item) => <TaskCard key={item.id} item={item} />)}</div>
      : <p className="section-empty">{empty}</p>}
  </section>;
}
