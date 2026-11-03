import { useAtomValue } from 'jotai';
import { countsAtom } from '../state/atoms';

export function BoardSummary() {
  const counts = useAtomValue(countsAtom);
  const metrics = [
    ['inbox', counts.inbox, 'ждут тебя', 'Нужно ваше решение'],
    ['reviews', counts.reviews, 'на ревью', 'Проверка изменений'],
    ['active', counts.active, 'в работе', 'Задачи и блокеры'],
    ['done', counts.done, 'готово', 'Смержено и завершено'],
  ] as const;
  return <section className="summary" aria-label="Сводка по доске">{metrics.map(([key, count, label, hint]) =>
    <div className={`summary-metric metric-${key}`} key={key}>
      <div><strong>{count}</strong><span>{label}</span></div><small>{hint}</small>
    </div>)}</section>;
}
