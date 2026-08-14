import type { LayoverBus } from '../../../shared/types';
import { Countdown } from './Countdown';
import { formatClock, formatHold } from '../format';

export function LayoverCard({
  bus,
  generatedAt,
  serviceDayStartSeconds,
}: {
  bus: LayoverBus;
  generatedAt: number;
  serviceDayStartSeconds: number;
}) {
  return (
    <div className="card layover-card">
      <div className="card-main">
        <span className="vehicle-id">{bus.vehicleId ? `#${bus.vehicleId}` : bus.tripId}</span>
        <span className="run">{bus.tripId}</span>
        {bus.restDelayed && <span className="badge rest-delayed">rest delayed</span>}
      </div>
      <div className="card-side">
        <span className="departs">
          {bus.restDelayed ? (
            <>
              <s>{formatClock(bus.scheduledDeparture, serviceDayStartSeconds)}</s>{' '}
              <span className="rest-delay-time">
                {formatClock(bus.expectedDeparture, serviceDayStartSeconds)}
              </span>
            </>
          ) : (
            formatClock(bus.expectedDeparture, serviceDayStartSeconds)
          )}
        </span>
        <Countdown seconds={bus.countdownSeconds} generatedAt={generatedAt} />
        {bus.hold && (
          <span className="hold-badge">
            held {formatHold(bus.hold.holdSeconds)} {'->'}{' '}
            {formatClock(bus.hold.effectiveDeparture, serviceDayStartSeconds)}
          </span>
        )}
      </div>
    </div>
  );
}
