/**
 * Pure-SVG horizontal block timeline: one colored segment per trip, a "now" line, and ticks for
 * observed departure facts. Identification is layered per FEATURE_VEHICLE_CARD.md because GTFS
 * route colors repeat system-wide: a prominent bold route number leads the label, direction
 * renders as a deterministic shade of the route color, and text contrast is recomputed on that
 * final shaded background. The GTFS trip_id is never shown as a user-facing label.
 */
import type { BlockTimeline, BlockTrip } from '../../../shared/types';
import { formatClock } from '../format';
import { normalizeGtfsColor, readableOn, shadeForDirection } from '../routeColor';

const PX_PER_SECOND = 0.04; // ~2.4 px per minute: readable spacing for a typical block
const PAD_SECONDS = 10 * 60; // 10 min padding before the first start and after the last end
const MIN_SEGMENT_PX = 26; // short deadhead/interlining legs stay wide enough to read/tap
const MIN_LABEL_PX = 78; // below this a segment shows only the route number (the full label moves to the tooltip)
const ROW_TOP = 10;
const ROW_HEIGHT = 40;
const HEIGHT = 78;
const TRACK_COLOR = '#e3e6eb';

function xOf(serviceSeconds: number, from: number, span: number, width: number): number {
  return ((serviceSeconds - from) / span) * width;
}

// The final background a trip segment renders: shadeForDirection tints the GTFS color for
// direction 1 (or toward black for already-light bases) so same-hue routes stay distinguishable.
function segmentFill(trip: BlockTrip): string {
  return shadeForDirection(normalizeGtfsColor(trip.color) ?? '#6b7280', trip.directionId);
}

// GTFS text_color applies to the unshaded variant only; shaded segments re-derive contrast.
function segmentInk(trip: BlockTrip): string {
  const background = segmentFill(trip);
  if (trip.directionId === undefined || trip.directionId === 0) {
    return normalizeGtfsColor(trip.textColor) ?? readableOn(background);
  }
  return readableOn(background);
}

function fullLabel(trip: BlockTrip, serviceDayStartSeconds: number): string {
  return `${trip.routeShortName} to ${trip.destination} · ${formatClock(trip.start, serviceDayStartSeconds)}–${formatClock(trip.end, serviceDayStartSeconds)}`;
}

export function BlockStrip({
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

  const firstStart = Math.min(...trips.map((t) => t.start));
  const lastEnd = Math.max(...trips.map((t) => t.end));
  const from = firstStart - PAD_SECONDS;
  const to = lastEnd + PAD_SECONDS;
  const span = Math.max(1, to - from);
  const width = Math.max(280, Math.round(span * PX_PER_SECOND));
  const nowX = xOf(timeline.nowSvc, from, span, width);
  const nowInView = timeline.nowSvc >= from && timeline.nowSvc <= to;

  return (
    <div className="block-strip-scroll">
      <svg
        className="block-strip"
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={`Block ${timeline.blockId} service timeline`}
      >
        <rect x={0} y={ROW_TOP} width={width} height={ROW_HEIGHT} rx={8} fill={TRACK_COLOR} />
        {trips.map((trip) => {
          const left = xOf(trip.start, from, span, width);
          const right = xOf(trip.end, from, span, width);
          let segX = left;
          let segWidth = Math.max(0, right - left);
          if (segWidth < MIN_SEGMENT_PX) {
            // Short legs stay wide enough to read by centering the minimum segment width.
            const center = (left + right) / 2;
            segWidth = MIN_SEGMENT_PX;
            segX = center - segWidth / 2;
          }
          const fill = segmentFill(trip);
          const ink = segmentInk(trip);
          const wide = segWidth >= MIN_LABEL_PX;
          const departedX = trip.departedSeconds !== undefined
            ? xOf(trip.departedSeconds, from, span, width)
            : null;
          return (
            <g key={trip.tripId}>
              <rect
                x={segX}
                y={ROW_TOP}
                width={segWidth}
                height={ROW_HEIGHT}
                rx={6}
                fill={fill}
                opacity={trip.state === 'past' ? 0.55 : 1}
                stroke={trip.state === 'current' ? ink : 'none'}
                strokeWidth={trip.state === 'current' ? 3 : 0}
              >
                <title>{fullLabel(trip, serviceDayStartSeconds)}</title>
              </rect>
              {/* The route number is the primary identifier; the label leads with it in bold. */}
              <text x={segX + 8} y={ROW_TOP + 20} fill={ink} fontWeight={700} fontSize={14}>
                {trip.routeShortName}
              </text>
              {wide && (
                <text x={segX + 8} y={ROW_TOP + 33} fill={ink} fontSize={10} opacity={0.9}>
                  {trip.destination}
                </text>
              )}
              {/* Direction stays a monochrome cue (chevron) so same-hue trips are readable even
                  outside color; the legend chip explains solid/tinted for the shade encoding. */}
              <text x={segX + segWidth - 16} y={ROW_TOP + 24} fill={ink} fontSize={13} fontWeight={700}>
                {trip.directionId === 1 ? '▸' : '◂'}
                <title>{`direction ${trip.directionId === 1 ? 1 : 0}`}</title>
              </text>
              {departedX !== null && (
                <line
                  x1={departedX}
                  y1={ROW_TOP + ROW_HEIGHT + 2}
                  x2={departedX}
                  y2={ROW_TOP + ROW_HEIGHT + 10}
                  stroke="#1c2330"
                  strokeWidth={1.5}
                >
                  <title>
                    {`departed ${formatClock(trip.departedSeconds!, serviceDayStartSeconds)}`}
                  </title>
                </line>
              )}
            </g>
          );
        })}
        {nowInView && (
          <g className="block-strip-now">
            <line x1={nowX} y1={ROW_TOP - 4} x2={nowX} y2={ROW_TOP + ROW_HEIGHT + 4} stroke="#dc2626" strokeWidth={2} />
            <text x={nowX + 3} y={ROW_TOP - 4} fill="#dc2626" fontSize={10} fontWeight={700}>
              now
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}