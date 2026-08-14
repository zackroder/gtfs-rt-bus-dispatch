import type { IncomingBus } from '../../../shared/types';
import { Countdown } from './Countdown';
import { formatClock, formatDelay } from '../format';

export function BusCard({
  bus,
  generatedAt,
  serviceDayStartSeconds,
}: {
  bus: IncomingBus;
  generatedAt: number;
  serviceDayStartSeconds: number;
}) {
  const tone = bus.delaySeconds > 60 ? 'late' : bus.delaySeconds < -60 ? 'early' : '';
  return (
    <div className="card bus-card">
      <div className="card-main">
        <span className="vehicle-id">{bus.vehicleId ? `#${bus.vehicleId}` : bus.tripId}</span>
        <span className="run">{bus.tripId}</span>
      </div>
      <div className="card-side">
        <span className="arrival">arr {formatClock(bus.predictedArrival, serviceDayStartSeconds)}</span>
        <Countdown seconds={bus.etaSeconds} generatedAt={generatedAt} />
        <span className={`delay ${tone}`}>{formatDelay(bus.delaySeconds)}</span>
      </div>
      <div className="card-detail">
        <span className="next-trip">
          Next trip: #{bus.routeShortName} to {bus.nextDestination}
        </span>
        <span className="departs">
          {bus.restDelayed ? (
            <>
              <s>{formatClock(bus.scheduledDeparture, serviceDayStartSeconds)}</s>{' '}
              <span className="rest-delay-time">
                {formatClock(bus.expectedDeparture, serviceDayStartSeconds)}
              </span>
            </>
          ) : (
            `dep ${formatClock(bus.expectedDeparture, serviceDayStartSeconds)}`
          )}
        </span>
      </div>
    </div>
  );
}
