import { useAtom, useAtomValue } from 'jotai';
import { dialogOpenAtom, noticeAtom } from '../state/atoms';
import { Icon } from './Icon';

const appearance = {
  success: { icon: 'check', role: 'status' },
  warning: { icon: 'alert', role: 'status' },
  error: { icon: 'alert', role: 'alert' },
} as const;
export function ActionNotice() {
  const [notice, setNotice] = useAtom(noticeAtom);
  if (!notice) return null;
  const style = appearance[notice.tone];
  return <div className={`notice notice-${notice.tone}`} role={style.role}>
    <Icon name={style.icon} /><span>{notice.text}</span>
    <button className="icon-button" aria-label="Скрыть уведомление" onClick={() => setNotice(null)}><Icon name="close" /></button>
  </div>;
}
export function PageNotice() {
  const dialogOpen = useAtomValue(dialogOpenAtom);
  if (dialogOpen) return null;
  return <ActionNotice />;
}
