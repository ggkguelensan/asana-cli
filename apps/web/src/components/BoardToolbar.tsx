import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { boardAtom, canRefreshAtom, canTrackAtom, filteredItemsAtom, kindAtom, searchAtom, trackDialogAtom } from '../state/atoms';
import type { BoardController } from '../state/controller';
import { Icon } from './Icon';

export function BoardToolbar({ controller }: { controller: BoardController }) {
  const [query, setQuery] = useAtom(searchAtom);
  const [kind, setKind] = useAtom(kindAtom);
  const board = useAtomValue(boardAtom);
  const canRefresh = useAtomValue(canRefreshAtom);
  const canTrack = useAtomValue(canTrackAtom);
  const items = useAtomValue(filteredItemsAtom);
  const openTrack = useSetAtom(trackDialogAtom);
  return <div className="toolbar">
    <label className="search-field"><Icon name="search" /><span className="sr-only">Поиск по задачам</span>
      <input type="search" placeholder="Найти задачу…" value={query} onChange={(event) => setQuery(event.target.value)} />
    </label>
    <div className="filter-group" aria-label="Тип работы">
      {([['all', 'Все'], ['task', 'Задачи'], ['review', 'Ревью']] as const).map(([value, label]) =>
        <button className="filter-button" key={value} aria-pressed={kind === value} onClick={() => setKind(value)}>{label}</button>)}
    </div>
    <span className="filtered-count" aria-live="polite">Показано {items.length} из {board?.items.length ?? 0}</span>
    <div className="toolbar-actions">
      <button className="button button-secondary" disabled={!canRefresh}
        onClick={() => void controller.refreshSources()}><Icon name="refresh" />Обновить</button>
      {(controller.mode === 'demo' || board?.capabilities.track === true) && <button className="button button-primary" disabled={!canTrack}
        onClick={() => openTrack(true)}><Icon name="plus" />Отслеживать задачу</button>}
    </div>
  </div>;
}
