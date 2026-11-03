import { STATUS, type WorkStatus } from '../model/board';

export function StatusBadge({ status, className = '' }: { status: WorkStatus; className?: string }) {
  return <span className={`status-badge status-${status} ${className}`}><span className="status-dot" />{STATUS[status]}</span>;
}
