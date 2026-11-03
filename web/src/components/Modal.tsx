import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';

function syncDialog(dialog: HTMLDialogElement, open: boolean): void {
  if (dialog.open === open) return;
  if (open) dialog.showModal();
  else dialog.close();
}

export function Modal({ open, title, titleId, onClose, children, drawer = false }:
  { open: boolean; title: string; titleId: string; onClose(): void; children: ReactNode; drawer?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    syncDialog(dialog, open);
  }, [open]);
  return <dialog ref={ref} className={`modal ${drawer ? 'detail-drawer' : ''}`} aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose}>
    <div className="modal-header"><h2 id={titleId}>{title}</h2>
      <button className="icon-button" aria-label="Закрыть" onClick={onClose}><Icon name="close" /></button></div>
    {children}
  </dialog>;
}
