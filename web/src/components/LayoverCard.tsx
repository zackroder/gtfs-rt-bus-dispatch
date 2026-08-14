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
  const late = bus.terminalArrival > bus.scheduledArrival;
  const arrival =
    bus.terminalArrival > 0 ? formatClock(bus.terminalArrival, serviceDayStartSeconds) : '—';
  const scheduledArrival =
    bus.scheduledArrival > 0 ? formatClock(bus.scheduledArrival, serviceDayStartSeconds) : '—';
  return (
    <div className="card layover-card">
      <div className="card-main">
        <span className="vehicle-id">{bus.vehicleId ? `#${bus.vehicleId}` : bus.tripId}</span>
        <span className="run">{bus.tripId}</span>
        {bus.restDelayed && <span className="badge rest-delayed">delayed</span>}
      </div>
      <div className="card-side">
        <span className={`arrival ${late ? 'late' : ''}`}>
          arr {arrival} / sched {scheduledArrival}
        </span>
        <span className="departs">
          dep {formatClock(bus.predictedDeparture, serviceDayStartSeconds)} / sched{' '}
          {formatClock(bus.scheduledDeparture, serviceDayStartSeconds)}
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
