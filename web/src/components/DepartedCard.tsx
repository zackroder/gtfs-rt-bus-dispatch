import type { DepartedBus } from '../../../shared/types';
import { formatClock } from '../format';

export function DepartedCard({
  bus,
  serviceDayStartSeconds,
}: {
  bus: DepartedBus;
  serviceDayStartSeconds: number;
}) {
  return (
    <div className="card departed-card">
      <div className="card-main">
        <span className="vehicle-id">{bus.vehicleId ? `#${bus.vehicleId}` : bus.tripId}</span>
        <span className="run">{bus.tripId}</span>
      </div>
      <div className="card-side">
        <span className="departs">
          dep {formatClock(bus.departureSeconds, serviceDayStartSeconds)}
        </span>
        <span className="next-trip">to {bus.headsign ?? bus.routeShortName}</span>
      </div>
    </div>
  );
}
