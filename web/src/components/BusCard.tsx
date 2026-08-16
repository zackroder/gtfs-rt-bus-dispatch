/** Card for an inbound vehicle and the outbound trip it is expected to form. */
import type { IncomingBus } from '../../../shared/types';
import { RouteBadge } from './RouteBadge';
import { formatClock } from '../format';

export function BusCard({
  bus,
  routeColor,
  routeTextColor,
  serviceDayStartSeconds,
}: {
  bus: IncomingBus;
  routeColor?: string;
  routeTextColor?: string;
  serviceDayStartSeconds: number;
}) {
  // Arrival comparison drives the visual late state; the displayed clock values
  // remain in service-day coordinates so overnight trips format correctly.
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
          Next trip:{' '}
          <RouteBadge
            shortName={bus.routeShortName}
            color={routeColor}
            textColor={routeTextColor}
          />{' '}
          to {bus.nextDestination}
        </span>
        <span className="departs">
          dep {formatClock(bus.expectedDeparture, serviceDayStartSeconds)} / sched{' '}
          {formatClock(bus.scheduledDeparture, serviceDayStartSeconds)}
        </span>
      </div>
    </div>
  );
}
