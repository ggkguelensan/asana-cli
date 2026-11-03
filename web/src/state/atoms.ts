import { atom } from 'jotai';
import { createStore } from 'jotai/vanilla';
import { isFinished, sortItems, type BoardSnapshot } from '../model/board';

export type BoardStore = ReturnType<typeof createStore>;
type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline' |
  'unauthorized' | 'invalid_response' | 'stopped';
export const boardAtom = atom<BoardSnapshot | null>(null);
export const connectionAtom = atom<ConnectionState>('connecting');
export const searchAtom = atom('');
export const kindAtom = atom<'all' | 'task' | 'review'>('all');
export const selectedIdAtom = atom<string | null>(null);
export const archiveOpenAtom = atom(false);
export const themeAtom = atom<'system' | 'light' | 'dark'>('system');
export const stopDialogAtom = atom(false);
export const trackDialogAtom = atom(false);
export const trackInputAtom = atom('');
export const dialogOpenAtom = atom((get) => Boolean(get(selectedIdAtom) || get(stopDialogAtom) || get(trackDialogAtom)));
export const pendingAtom = atom<readonly string[]>([]);
export const noticeAtom = atom<{ tone: 'success' | 'warning' | 'error'; text: string } | null>(null);

export const selectedItemAtom = atom((get) =>
  get(boardAtom)?.items.find((item) => item.id === get(selectedIdAtom)) ?? null);
export const connectedAtom = atom((get) => get(connectionAtom) === 'live');
const capabilitiesAtom = atom((get) => get(boardAtom)?.capabilities ?? { track: false, refresh: false, stop: false });
export const canTrackAtom = atom((get) => get(connectedAtom) && get(capabilitiesAtom).track);
export const canRefreshAtom = atom((get) => get(connectedAtom) && get(capabilitiesAtom).refresh && !get(pendingAtom).includes('refresh'));
function matchesText(item: { key: string; title: string | null; waiting?: string; owner: string }, query: string): boolean {
  return `${item.key} ${item.title ?? ''} ${item.waiting ?? ''} ${item.owner}`.toLocaleLowerCase('ru').includes(query);
}
export const filteredItemsAtom = atom((get) => {
  const query = get(searchAtom).trim().toLocaleLowerCase('ru');
  const kind = get(kindAtom);
  return sortItems((get(boardAtom)?.items ?? []).filter((item) =>
    (kind === 'all' || item.kind === kind) &&
    matchesText(item, query)));
});
export const sectionsAtom = atom((get) => {
  const items = get(filteredItemsAtom);
  const active = items.filter((item) => item.status !== 'wait_user' && !isFinished(item));
  return {
    inbox: items.filter((item) => item.status === 'wait_user'),
    tasks: active.filter((item) => item.kind === 'task'),
    reviews: active.filter((item) => item.kind === 'review'),
    archive: items.filter(isFinished),
  };
});
export const countsAtom = atom((get) => {
  const items = get(boardAtom)?.items ?? [];
  return {
    total: items.length,
    inbox: items.filter((item) => item.status === 'wait_user').length,
    reviews: items.filter((item) => ['review', 'reviewing'].includes(item.status)).length,
    active: items.filter((item) => ['work', 'blocked'].includes(item.status)).length,
    done: items.filter(isFinished).length,
  };
});
