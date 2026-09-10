/**
 * Vertical block manifest: one compact row per trip in block order, showing origin -> destination,
 * the inferred cardinal direction, the scheduled window, and observed terminal arrival/departure
 * facts when the ledger recorded them. Pure DOM (no SVG) so rows read at mobile width with explicit
 * clock times — replacing the horizontal Gantt strip, whose pixel-scaled segments and hover-only
 * tooltips could not convey readable times or fit a phone viewport.
 */
import type { BlockTimeline, BlockTrip } from '../../../shared/types';
import { formatClock, formatDelay } from '../format';
import { RouteBadge } from './RouteBadge';

// The observed-times line: `arr HH:MM · dep HH:MM (+2 min)` — present only when a terminal fact
// was recorded, so non-terminal legs of a block stay schedule-only rather than implying an event.
function observedLine(trip: BlockTrip, serviceDayStartSeconds: number): string | undefined {
  if (trip.arrivedSeconds === undefined && trip.departedSeconds === undefined) return undefined;
  const parts: string[] = [];
  if (trip.arrivedSeconds !== undefined) {
    parts.push(`arr ${formatClock(trip.arrivedSeconds, serviceDayStartSeconds)}`);
  }
  if (trip.departedSeconds !== undefined) {
    const delay = trip.departedSeconds - trip.scheduledDeparture;
    parts.push(`dep ${formatClock(trip.departedSeconds, serviceDayStartSeconds)} (${formatDelay(delay)})`);
  }
  return parts.join(' · ');
}

export function BlockList({
  timeline,
  serviceDayStartSeconds,
}: {
  timeline: BlockTimeline;
  serviceDayStartSeconds: number;
}) {
  const { trips } = timeline;
  if (trips.length === 0) {
    return <p className="empty">No trips on this block for today.</p>;
  }

  return (
    <ol className="block-list">
      {trips.map((trip) => {
        const observed = observedLine(trip, serviceDayStartSeconds);
        return (
          <li key={trip.tripId} className={`block-trip state-${trip.state}`}>
            <div className="block-trip-row">
              <RouteBadge
                shortName={trip.routeShortName}
                color={trip.color}
                textColor={trip.textColor}
              />
              {trip.directionLabel !== undefined ? (
                <span className="block-trip-direction">{trip.directionLabel}</span>
              ) : (
                <span
                  className="block-trip-direction"
                  role="img"
                  aria-label={`direction ${trip.directionId === 1 ? 1 : 0}`}
                >
                  {trip.directionId === 1 ? '▸' : '◂'}
                </span>
              )}
              <span className="block-trip-endpoints">
                <span className="block-trip-origin">{trip.origin}</span>
                <span className="block-trip-arrow" aria-hidden="true">→</span>
                <span className="block-trip-destination">{trip.destination}</span>
              </span>
              {trip.state === 'current' && <span className="badge current">now</span>}
              {trip.held && <span className="hold-badge">held</span>}
            </div>
            <div className="block-trip-times">
              <span className="block-trip-sched">
                {formatClock(trip.scheduledDeparture, serviceDayStartSeconds)}–{formatClock(trip.scheduledArrival, serviceDayStartSeconds)}
              </span>
              {observed !== undefined && <span className="block-trip-observed">{observed}</span>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}