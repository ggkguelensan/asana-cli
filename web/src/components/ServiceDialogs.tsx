import { useAtom, useAtomValue } from 'jotai';
import { connectedAtom, pendingAtom, stopDialogAtom, trackDialogAtom, trackInputAtom } from '../state/atoms';
import type { BoardController } from '../state/controller';
import { Modal } from './Modal';
import { ActionNotice } from './ActionNotice';

function StopDialog({ controller }: { controller: BoardController }) {
  const [open, setOpen] = useAtom(stopDialogAtom);
  const connected = useAtomValue(connectedAtom);
  const pending = useAtomValue(pendingAtom);
  return <Modal open={open} title="Остановить сервис?" titleId="stop-title" onClose={() => setOpen(false)}>
    <div className="modal-body"><p>Синхронизация и обновления доски остановятся. Задачи и локальные данные сохранятся.</p>
      <p className="muted">Чтобы продолжить работу, потребуется снова запустить сервис на компьютере.</p></div>
    <div className="modal-actions"><button className="button button-secondary" onClick={() => setOpen(false)}>Отмена</button>
      <button className="button button-danger" disabled={!connected || pending.includes('stop')}
        onClick={() => void controller.stop()}>Остановить сервис</button></div>
  </Modal>;
}
function validTrack(connected: boolean, gid: string, pending: readonly string[]): boolean {
  return connected && /^\d{1,32}$/.test(gid.trim()) && !pending.includes('track');
}
function TrackDialog({ controller }: { controller: BoardController }) {
  const [open, setOpen] = useAtom(trackDialogAtom);
  const [gid, setGid] = useAtom(trackInputAtom);
  const pending = useAtomValue(pendingAtom);
  const connected = useAtomValue(connectedAtom);
  return <Modal open={open} title="Отслеживать задачу" titleId="track-title" onClose={() => setOpen(false)}>
    <form onSubmit={(event) => { event.preventDefault(); void controller.track(); }}>
      <div className="modal-body"><ActionNotice /><label className="form-field">ID задачи Asana
        <input autoComplete="off" inputMode="numeric" pattern="[0-9]{1,32}" maxLength={32} required
          placeholder="Например, 1234567890123456" value={gid} onChange={(event) => setGid(event.target.value)} /></label>
        <p className="muted">Добавим задачу на доску. Сама задача в Asana не изменится.</p></div>
      <div className="modal-actions"><button type="button" className="button button-secondary" onClick={() => setOpen(false)}>Отмена</button>
        <button type="submit" className="button button-primary" disabled={!validTrack(connected, gid, pending)}>
          {pending.includes('track') ? 'Добавляем…' : 'Добавить на доску'}</button></div>
    </form>
  </Modal>;
}
export function ServiceDialogs({ controller }: { controller: BoardController }) {
  return <><StopDialog controller={controller} /><TrackDialog controller={controller} /></>;
}
