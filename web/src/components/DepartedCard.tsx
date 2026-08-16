/** Card retaining recently departed vehicles for dispatch context and traceability. */
import type { DepartedBus } from '../../../shared/types';
import { formatClock } from '../format';

export function DepartedCard({
  bus,
  serviceDayStartSeconds,
}: {
  bus: DepartedBus;
  serviceDayStartSeconds: number;
}) {
  // A held departure is marked in the same compact line as its actual departure time.
  return (
    <div className="card departed-card">
      <div className="card-main">
        <span className="vehicle-id">{bus.vehicleId ? `#${bus.vehicleId}` : bus.tripId}</span>
        <span className="run">{bus.tripId}</span>
      </div>
      <div className="card-side">
        <span className={`departs ${bus.held ? 'held' : ''}`}>
          dep {formatClock(bus.departureSeconds, serviceDayStartSeconds)}
        </span>
        <span className="arrival">
          sched {formatClock(bus.scheduledDeparture, serviceDayStartSeconds)}
        </span>
      </div>
      <div className="card-detail">
        <span className="next-trip">to {bus.headsign ?? bus.routeShortName}</span>
        <span className="current-stop">now at {bus.currentStop ?? '—'}</span>
      </div>
    </div>
  );
}
