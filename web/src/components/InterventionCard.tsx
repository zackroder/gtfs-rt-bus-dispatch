import type { Intervention } from '../../../shared/types';
import { formatClock, formatHold } from '../format';

export function InterventionCard({
  intervention,
  serviceDayStartSeconds,
}: {
  intervention: Intervention;
  serviceDayStartSeconds: number;
}) {
  return (
    <div className="intervention">
      <div className="intervention-title">
        Hold {intervention.vehicleId ?? 'bus'} until{' '}
        {intervention.until !== undefined
          ? formatClock(intervention.until, serviceDayStartSeconds)
          : ''}{' '}
        ({formatHold(intervention.holdSeconds)})
      </div>
      <div className="intervention-reason">{intervention.reason}</div>
    </div>
  );
}
