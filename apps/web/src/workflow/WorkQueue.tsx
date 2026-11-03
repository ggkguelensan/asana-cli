import { useEffect } from 'react';
import { useAtom, useAtomValue, useStore } from 'jotai';
import { loadWork, actOnWork, type Work, type WorkAction } from '@asana-cli/service-client/workflow';
import { boardAtom } from '../state/atoms';
import { WorkCard } from './WorkCard';
import { workItemsAtom, workRefreshAtom, workErrorAtom, workBusyAtom, workTokensAtom, workError } from './state';

export function WorkQueue() {
  const store = useStore(); const board = useAtomValue(boardAtom); const refresh = useAtomValue(workRefreshAtom);
  const [items,setItems] = useAtom(workItemsAtom); const [error,setError] = useAtom(workErrorAtom);
  const [tokens,setTokens] = useAtom(workTokensAtom); const [busy,setBusy] = useAtom(workBusyAtom);
  useEffect(() => {
    const abort = new AbortController();
    const load = () => void loadWork(abort.signal).then(value => setItems(value.items)).catch(() => {});
    load(); const timer = setInterval(load, 5000); return () => { abort.abort(); clearInterval(timer); };
  }, [board?.cursor,refresh]);
  async function act(work: Work, action: WorkAction) {
    if (!board) return; setBusy(value => [...value,work.id]); setError('');
    try {
      const updated = await actOnWork(work.id, action, board.csrf_token);
      setItems(value => value.map(item => item.id === updated.id ? updated : item));
      if (action.kind === 'claim') setTokens(value => ({ ...value,[work.id]:action.lease_token }));
    } catch (failure) { setError(workError(failure)); store.set(workRefreshAtom,value => value + 1); }
    finally { setBusy(value => value.filter(id => id !== work.id)); }
  }
  useEffect(() => {
    const timer = setInterval(() => {
      const current = store.get(boardAtom); if (!current) return;
      store.get(workItemsAtom).filter(work => work.status === 'running').forEach(work => {
        const token = store.get(workTokensAtom)[work.id]; if (!token) return;
        void actOnWork(work.id, { kind:'heartbeat', expected_revision:work.revision, lease_token:token }, current.csrf_token)
          .then(updated => store.set(workItemsAtom,items => items.map(item => item.id === updated.id ? updated : item)))
          .catch(() => store.set(workRefreshAtom,value => value + 1));
      });
    },20000); return () => clearInterval(timer);
  }, []);
  if (!items.length) return null;
  return <section className="work-queue"><h2>Работа и продолжения</h2><p>Ожидания сохраняются в core. Готовые продолжения принимаются вручную или внешним исполнителем через CLI.</p>
    {error && <p role="alert">{error}</p>}
    <div className="workflow-grid">{items.map(work => <WorkCard key={work.id} work={work} token={tokens[work.id]} act={act} busy={busy.includes(work.id)}/>)}</div>
  </section>;
}
