import type { Intervention } from '../../../shared/types';
import { formatClock, formatHold } from '../format';

function title(intervention: Intervention): string {
  switch (intervention.rule) {
    case 'hold_leader':
      return `Hold ${intervention.vehicleId ?? 'leader'} until ${intervention.until !== undefined ? formatClock(intervention.until) : ''} (${formatHold(intervention.holdSeconds)})`;
    case 'hold_follower':
      return `Hold follower ${intervention.vehicleId ?? ''} until ${intervention.until !== undefined ? formatClock(intervention.until) : ''} (${formatHold(intervention.holdSeconds)})`;
    case 'gap_alert':
      return 'Service gap — leader already departed';
    case 'min_rest':
      return 'Minimum rest advisory';
  }
}

export function InterventionCard({ intervention }: { intervention: Intervention }) {
  return (
    <div className={`intervention ${intervention.rule}`}>
      <div className="intervention-title">{title(intervention)}</div>
      <div className="intervention-reason">{intervention.reason}</div>
    </div>
  );
}
