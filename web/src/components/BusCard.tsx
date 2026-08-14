import type { IncomingBus } from '../../../shared/types';
import { formatClock } from '../format';

export function BusCard({
  bus,
  serviceDayStartSeconds,
}: {
  bus: IncomingBus;
  serviceDayStartSeconds: number;
}) {
  const late = bus.predictedArrival > bus.scheduledArrival;
  return (
    <div className="card bus-card">
      <div className="card-main">
        <span className="vehicle-id">{bus.vehicleId ? `#${bus.vehicleId}` : bus.tripId}</span>
        <span className="run">{bus.tripId}</span>
      </div>
      <div className="card-side">
        <span className="arrival">
          sched arr {formatClock(bus.scheduledArrival, serviceDayStartSeconds)}
        </span>
        <span className={`arrival est ${late ? 'late' : ''}`}>
          est arr {formatClock(bus.predictedArrival, serviceDayStartSeconds)}
        </span>
      </div>
      <div className="card-detail">
        <span className="next-trip">
          Next trip: #{bus.routeShortName} to {bus.nextDestination}
        </span>
        <span className="departs">
          dep {formatClock(bus.expectedDeparture, serviceDayStartSeconds)} / sched{' '}
          {formatClock(bus.scheduledDeparture, serviceDayStartSeconds)}
        </span>
      </div>
    </div>
  );
}
