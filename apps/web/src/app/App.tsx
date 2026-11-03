import { WorkQueue } from '../workflow/WorkQueue';
import { TrackingSettings } from '../components/TrackingSettings';
import { useEffect } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { archiveOpenAtom, boardAtom, connectionAtom, kindAtom, searchAtom, sectionsAtom } from '../state/atoms';
import type { BoardController } from '../state/controller';
import { BoardHeader } from '../components/BoardHeader';
import { BoardSummary } from '../components/BoardSummary';
import { BoardToolbar } from '../components/BoardToolbar';
import { BoardSection } from '../components/BoardSection';
import { TaskCard } from '../components/TaskCard';
import { TaskDetails } from '../components/TaskDetails';
import { ServiceDialogs } from '../components/ServiceDialogs';
import { PageNotice } from '../components/ActionNotice';
import { Icon } from '../components/Icon';

function BoardContent() {
  const sections = useAtomValue(sectionsAtom);
  const [open, setOpen] = useAtom(archiveOpenAtom);
  const setQuery = useSetAtom(searchAtom);
  const setKind = useSetAtom(kindAtom);
  const count = Object.values(sections).reduce((sum, items) => sum + items.length, 0);
  if (!count) return <div className="empty-state"><Icon name="search" /><h2>Задач пока нет</h2>
    <p>Измените фильтры или добавьте задачу в отслеживание.</p>
    <button className="button button-secondary" onClick={() => { setQuery(''); setKind('all'); }}>Сбросить фильтры</button></div>;
  return <div className="board-content">
    <BoardSection title="Ждёт тебя" items={sections.inbox} empty="Сейчас от вас ничего не ждут." inbox />
    <div className="board-columns">
      <BoardSection title="Мои задачи" items={sections.tasks} empty="Других активных задач нет." />
      <BoardSection title="Ревью чужих MR" items={sections.reviews} empty="Открытых ревью нет." />
    </div>
    {sections.archive.length > 0 && <details className="archive" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary><Icon name="chevron" className={open ? 'archive-chevron expanded' : 'archive-chevron'} /><span>Готово</span><span className="section-count">{sections.archive.length}</span>
        <span className="archive-hint">Смержено и завершено</span></summary>
      <div className="task-grid">{sections.archive.map((item) => <TaskCard key={item.id} item={item} />)}</div>
    </details>}
  </div>;
}

function ConnectionControls({ controller }: { controller: BoardController }) {
  const state = useAtomValue(connectionAtom);
  const board = useAtomValue(boardAtom);
  const retry = !['connecting', 'reconnecting', 'stopped'].includes(state);
  return <>
    {retry && <button className="button button-secondary" onClick={() => void controller.refresh()}>Повторить</button>}
    {!board && state !== 'connecting' && <a className="text-link" href="?demo=1">Открыть пример доски<Icon name="arrow" /></a>}
    <RestartExample controller={controller} />
  </>;
}
function RestartExample({ controller }: { controller: BoardController }) {
  const state = useAtomValue(connectionAtom);
  if (controller.mode !== 'demo' || state !== 'stopped') return null;
  return <a className="text-link" href="?demo=1">Перезапустить пример</a>;
}
function ConnectionMessage({ controller }: { controller: BoardController }) {
  const state = useAtomValue(connectionAtom);
  const board = useAtomValue(boardAtom);
  if (state === 'live') return null;
  const copy = {
    connecting: ['Подключаемся к доске', 'Получаем задачи и состояние работы.'],
    reconnecting: ['Восстанавливаем соединение', 'Показаны последние полученные данные.'],
    offline: ['Сервис недоступен', 'Проверьте подключение сервиса. Изменения временно недоступны.'],
    unauthorized: ['Нужно подключение к сервису', 'Откройте доску из авторизованного сервиса.'],
    invalid_response: ['Не удалось прочитать доску', 'Проверьте совместимость версий приложения и сервиса.'],
    stopped: ['Сервис остановлен', 'Данные сохранены. Запустите сервис на компьютере, чтобы продолжить.'],
  }[state];
  return <section className={`connection-message ${board ? 'connection-message-compact' : ''}`} role="status">
    <Icon name={state === 'connecting' ? 'grid' : 'alert'} /><div><h2>{copy[0]}</h2><p>{copy[1]}</p></div>
    <ConnectionControls controller={controller} />
  </section>;
}

export function App({ controller }: { controller: BoardController }) {
  const board = useAtomValue(boardAtom);
  useEffect(() => controller.connect(), [controller]);
  return <div className="app-shell"><a className="skip-link" href="#board-main">К задачам</a>
    <BoardHeader demo={controller.mode === 'demo'} />
    <main id="board-main">
      {controller.mode === 'demo' && <div className="demo-banner"><span><b>Данные примера.</b> Изменения действуют до перезагрузки страницы.</span><a href="/">Подключить сервис<Icon name="arrow" /></a></div>}
      <ConnectionMessage controller={controller} /><PageNotice />
      {controller.mode === 'service' && <><TrackingSettings /><WorkQueue /></>}
      {board && <><BoardSummary /><BoardToolbar controller={controller} /><BoardContent /></>}
    </main>
    <footer className="page-footer"><span>asana-cli</span><span>Каждому ожиданию — следующий шаг.</span></footer>
    <TaskDetails controller={controller} /><ServiceDialogs controller={controller} />
  </div>;
}
