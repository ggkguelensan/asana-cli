import type { ChangeRef } from '../model/board';
import { Icon } from './Icon';

const ciLabels = { success: 'CI успешно', failed: 'CI с ошибкой', running: 'CI выполняется', unknown: 'CI неизвестен' };

function ChangeContent({ change }: { change: ChangeRef }) {
  return <>
      <span className={`ci-dot ci-${change.ci}`} role="img" aria-label={ciLabels[change.ci]} />
      <span className="mono">{change.label}</span>
      {change.approvals && <span className="change-approval">{change.approvals}</span>}
      {change.merged && <Icon name="check" />}
      {change.url && <Icon name="external" />}
  </>;
}
export function ChangeLinks({ changes }: { changes: readonly ChangeRef[] }) {
  return <div className="change-links">{changes.map((change) => {
    const content = <ChangeContent change={change} />;
    return change.url
      ? <a key={change.id} className="change-link" href={change.url} target="_blank" rel="noopener noreferrer">{content}</a>
      : <span key={change.id} className="change-link">{content}</span>;
  })}</div>;
}
