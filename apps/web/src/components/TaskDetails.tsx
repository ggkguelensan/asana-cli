import { useAtomValue, useSetAtom } from 'jotai';
import type { WorkAction, WorkItem } from '../model/board';
import { connectedAtom, pendingAtom, selectedIdAtom, selectedItemAtom } from '../state/atoms';
import type { BoardController } from '../state/controller';
import { Modal } from './Modal';
import { StatusBadge } from './StatusBadge';
import { ChangeLinks } from './ChangeLinks';
import { ActionNotice } from './ActionNotice';
import { Icon } from './Icon';

function TextSection({ title, text }: { title: string; text?: string }) {
  if (!text) return null;
  return <section className="detail-section"><h4>{title}</h4><p>{text}</p></section>;
}
function DetailMetadata({ item }: { item: WorkItem }) {
  const freshness = { fresh: 'Актуальны', stale: 'Устарели', unknown: 'Недоступны' };
  return <dl className="detail-meta"><div><dt>Ведёт работу</dt><dd>{item.owner}</dd></div>
    <div><dt>Данные Asana</dt><dd>{freshness[item.source]}</dd></div>
    <div><dt>Работа обновлена</dt><dd>{new Date(item.updated_at).toLocaleString('ru-RU')}</dd></div></dl>;
}
function DetailChanges({ item }: { item: WorkItem }) {
  if (!item.changes.length) return null;
  return <section className="detail-section"><h4>Связанные изменения</h4><ChangeLinks changes={item.changes} /></section>;
}
function SessionInfo({ session }: { session: WorkItem['session'] }) {
  if (!session) return null;
  return <TextSection title="Рабочая сессия" text={`${session.name} · ${session.online ? 'на связи' : 'не в сети'}`} />;
}
function actionDisabled(connected: boolean, action: WorkAction, pending: boolean): boolean {
  return !connected || !action.enabled || pending;
}
function ActionButton({ item, action, controller }: { item: WorkItem; action: WorkAction; controller: BoardController }) {
  const connected = useAtomValue(connectedAtom);
  const pending = useAtomValue(pendingAtom).includes(item.id);
  return <div><button className="button button-primary" disabled={actionDisabled(connected, action, pending)}
    onClick={() => void controller.runAction(item.id, action.id)}>{pending ? 'Выполняем…' : action.label}</button>
    {action.reason && <p className="muted">{action.reason}</p>}</div>;
}
function DetailActions({ item, controller }: { item: WorkItem; controller: BoardController }) {
  return <section className="detail-section"><h4>Действия с работой</h4>
    {item.actions.length ? <div className="detail-actions">{item.actions.map((action) =>
      <ActionButton key={action.id} item={item} action={action} controller={controller} />)}</div>
      : <p className="muted">Сейчас нет действий, требующих выполнения.</p>}
    <p className="action-note">Эти действия меняют работу на доске. Завершение работы не закрывает задачу в Asana.</p>
  </section>;
}
function DetailBody({ item, controller }: { item: WorkItem; controller: BoardController }) {
  return <div className="detail-content"><ActionNotice />
    <StatusBadge status={item.status} /><h3>{item.title ?? `Задача ${item.key}`}</h3>
    <DetailMetadata item={item} /><TextSection title="Что ожидается" text={item.waiting} />
    <TextSection title="Следующий шаг" text={item.next} /><DetailChanges item={item} />
    <SessionInfo session={item.session} /><DetailActions item={item} controller={controller} />
    {item.asana_url && <a className="button button-secondary" href={item.asana_url} target="_blank" rel="noopener noreferrer">
      Открыть в Asana<Icon name="external" /></a>}
  </div>;
}
function closeSelection(select: (id: string | null) => void, id: string | undefined): void {
  select(null);
  if (!id) return;
  requestAnimationFrame(() => document.getElementById(`work-title-${id}`)?.focus());
}
export function TaskDetails({ controller }: { controller: BoardController }) {
  const item = useAtomValue(selectedItemAtom);
  const select = useSetAtom(selectedIdAtom);
  return <Modal open={item !== null} title={item?.key ?? 'Задача'} titleId="task-detail-title" drawer onClose={() => closeSelection(select, item?.id)}>
    {item && <DetailBody item={item} controller={controller} />}
  </Modal>;
}
