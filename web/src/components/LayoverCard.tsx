/** Card for a bus at the terminal awaiting its next scheduled departure. */
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
  // Arrival can be observed or estimated; absent arrival data is deliberately shown
  // as unknown rather than inferred from the scheduled departure.
  const late = bus.terminalArrival !== undefined && bus.terminalArrival > bus.scheduledArrival;
  const arrival = bus.terminalArrival !== undefined
    ? formatClock(bus.terminalArrival, serviceDayStartSeconds)
    : '—';
  const scheduledArrival =
    bus.scheduledArrival > 0 ? formatClock(bus.scheduledArrival, serviceDayStartSeconds) : '—';
  return (
    <div className="card layover-card">
      <div className="card-main">
        <span className="vehicle-id">{bus.vehicleId ? `#${bus.vehicleId}` : bus.tripId}</span>
        <span className="run">{bus.tripId}</span>
        {bus.arrivalPending && <span className="arrival-pending"><span className="arrival-pending-dot" /> arriving</span>}
        {bus.departurePending && <span className="departure-pending"><span className="departure-pending-dot" /> departing</span>}
        {bus.restDelayed && <span className="badge rest-delayed">delayed</span>}
      </div>
      <div className="card-side">
        <span className={`arrival ${late ? 'late' : ''}`}>
          {bus.terminalArrivalSource === 'estimated' ? 'est ' : 'arr '}
          {arrival} / sched {scheduledArrival}
        </span>
        <span className="departs">
          dep {formatClock(bus.predictedDeparture, serviceDayStartSeconds)} / sched{' '}
          {formatClock(bus.scheduledDeparture, serviceDayStartSeconds)}
        </span>
        <Countdown seconds={bus.countdownSeconds} generatedAt={generatedAt} />
        {/* A hold is optional because most layovers have no intervention override. */}
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
