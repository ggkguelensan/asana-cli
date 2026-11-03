import { atom } from 'jotai';
import { WorkRequestError, type Work } from '@asana-cli/service-client/workflow';
export const workItemsAtom = atom<Work[]>([]);
export const workRefreshAtom = atom(0);
export const workErrorAtom = atom('');
export const workBusyAtom = atom<string[]>([]);
export const workTokensAtom = atom<Record<string,string>>({});
export function workError(error: unknown): string {
  if (!(error instanceof WorkRequestError)) return 'Сервис недоступен. Повторите подключение.';
  const labels: Record<string,string> = {
    condition_already_met: 'Это условие уже выполнено. Выберите будущее событие.',
    condition_changed: 'Условие больше не выполнено. Работа снова ожидает изменения Asana.',
    revision_conflict: 'Работа уже изменилась. Данные обновлены — повторите действие.',
    lease_expired: 'Связь с исполнителем истекла. Проверьте результат перед повторным запуском.',
    lease_mismatch: 'Эта работа принята другим исполнителем.',
    work_limit: 'Достигнут предел 500 сохранённых работ.',
  };
  return labels[error.code] ?? 'Действие недоступно в текущем состоянии. Обновите данные.';
}
