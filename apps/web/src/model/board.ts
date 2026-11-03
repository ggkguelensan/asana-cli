export { boardSchema, eventSchema, commandSchema, receiptSchema } from '@asana-cli/contracts';
export type { WorkStatus, WorkAction, ChangeRef, WorkItem, BoardSnapshot, BoardEvent, BoardCommand, CommandReceipt } from '@asana-cli/contracts';
import { workStatuses, type WorkItem } from '@asana-cli/contracts';
export const STATUS = {
  wait_user: 'Ждёт тебя', blocked: 'Блокер', review: 'На ревью', work: 'В работе',
  wait_others: 'Ждём других', reviewing: 'Ждём автора', merged: 'Смержено', done: 'Готово',
} as const;
export function isFinished(item: WorkItem): boolean {
  return item.status === 'done' || item.status === 'merged';
}
export function sortItems(items: readonly WorkItem[]): WorkItem[] {
  return [...items].sort((a, b) => workStatuses.indexOf(a.status) - workStatuses.indexOf(b.status) ||
    b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
}
