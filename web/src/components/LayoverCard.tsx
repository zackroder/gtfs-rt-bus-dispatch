import type { LayoverBus } from '../../../shared/types';
import { Countdown } from './Countdown';
import { formatClock, formatHold } from '../format';

export function LayoverCard({ bus, generatedAt }: { bus: LayoverBus; generatedAt: number }) {
  return (
    <div className="card layover-card">
      <div className="card-main">
        <span className="route">{bus.routeShortName}</span>
        <span className="run">{bus.tripId}</span>
        {bus.vehicleId && <span className="vehicle">#{bus.vehicleId}</span>}
        {bus.restDelayed && <span className="badge rest-delayed">rest delayed</span>}
      </div>
      <div className="card-side">
        <span className="departs">
          {bus.restDelayed ? (
            <>
              <s>{formatClock(bus.scheduledDeparture)}</s>{' '}
              <span className="rest-delay-time">{formatClock(bus.expectedDeparture)}</span>
            </>
          ) : (
            formatClock(bus.expectedDeparture)
          )}
        </span>
        <Countdown seconds={bus.countdownSeconds} generatedAt={generatedAt} />
        {bus.hold && (
          <span className="hold-badge">
            held {formatHold(bus.hold.holdSeconds)} {'->'} {formatClock(bus.hold.effectiveDeparture)}
          </span>
        )}
      </div>
    </div>
  );
}
