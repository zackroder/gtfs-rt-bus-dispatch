import type { Database } from 'better-sqlite3';
import type {
  BlockTimeline,
  BlockTrip,
  HoldOverride,
  StopTimePrediction,
  TripUpdateInfo,
  UpcomingStop,
  PassedStop,
  VehicleDetail,
} from '../../../shared/types';
import type { RealtimeSnapshot } from '../providers/types';
import { prepared } from '../db/prepare';
import { unixToServiceSeconds } from '../gtfs/time';
import { type BlockChains, type RunRecord, type TripEnd, resolveVehicleForTrip } from './headway';
import { bearingDegrees, type GeoPoint } from './geometry';
import type { RouteStyle } from './terminal';

// Read-only projection of the vehicle card and its block timeline. Both builders are pure
// (the Engine wrapper supplies the cached maps and ledger), so they never touch the feed
// provider or mutate engine state. See FEATURE_VEHICLE_CARD.md for the DTO contracts.

/** The classification/run facts lifted from the cached terminal snapshot card for this trip. */
export interface RunInfo {
  status: 'incoming' | 'layover' | 'departed';
  /** The trip the vehicle is currently operating when it differs from the card's run: incoming
   *  cards operate the inbound leg, whose upcoming stops the detail must render instead of the
   *  outbound run being formed. Absent for layover/departed (the run is the current trip). */
  currentTripId?: string;
  arrivalSource?: 'observed' | 'estimated';
  overdueSeconds?: number;
}

export interface BuildVehicleDetailDeps {
  db: Database;
  terminal: { id: string; stopIds: string[] };
  tripId: string;
  routeId: string;
  blockId?: string;
  directionId?: number;
  destination: string;
  rt: RealtimeSnapshot;
  generatedAt: number;      // unix seconds; anchors the VP age computation
  nowSvc: number;
  serviceDayStartSeconds: number;
  timeZone: string;
  tripEnds: ReadonlyMap<string, TripEnd>;
  blockChains: BlockChains;
  stopNames: ReadonlyMap<string, string>;
  stopCoords: ReadonlyMap<string, GeoPoint>;
  routeShortName: string;
  color?: string;
  textColor?: string;
  run: RunInfo;
  hold?: HoldOverride;
  /** Average of the terminal's stop coordinates; implied arrow headings point toward it. */
  center: GeoPoint;
}

interface StaticStop {
  stopSequence: number;
  stopId: string;
  scheduled: number;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

function coordsOf(deps: BuildVehicleDetailDeps, stopId: string): { lat?: number; lon?: number } {
  const coord = deps.stopCoords.get(stopId);
  return coord ? { lat: coord.lat, lon: coord.lon } : {};
}

// Load a trip's static stops on the service-day clock, ordered by sequence.
function loadStops(deps: BuildVehicleDetailDeps, tripId: string): StaticStop[] {
  const rows = prepared(
    deps.db,
    `SELECT stop_sequence, stop_id, arrival_time, departure_time
     FROM stop_times WHERE trip_id = ?
     ORDER BY stop_sequence ASC`,
  ).all(tripId) as Array<{
    stop_sequence: number;
    stop_id: string;
    arrival_time: number | null;
    departure_time: number | null;
  }>;
  return rows.map((row) => ({
    stopSequence: row.stop_sequence,
    stopId: row.stop_id,
    scheduled: row.arrival_time ?? row.departure_time ?? 0,
  }));
}

function toScheduledStop(deps: BuildVehicleDetailDeps, stop: StaticStop): UpcomingStop {
  return {
    stopId: stop.stopId,
    stopName: deps.stopNames.get(stop.stopId) ?? stop.stopId,
    stopSequence: stop.stopSequence,
    scheduled: stop.scheduled,
    source: 'scheduled',
    ...coordsOf(deps, stop.stopId),
  };
}

function toPassedStop(deps: BuildVehicleDetailDeps, stop: StaticStop): PassedStop {
  return {
    stopId: stop.stopId,
    stopName: deps.stopNames.get(stop.stopId) ?? stop.stopId,
    stopSequence: stop.stopSequence,
    ...coordsOf(deps, stop.stopId),
  };
}

// Whether a TU stop update refers to the stop the vehicle currently occupies. stop_id is the only
// trustworthy stop identity (the feed now carries it on ~99% of entities). current_stop_sequence is
// unreliable on this feed — CTA reports 1 at terminals regardless of the static sequence — so it is
// never used for stop resolution here; an update for the current stop is simply not shown as upcoming.
function isCurrentStop(
  update: StopTimePrediction,
  currentStopId: string | undefined,
): boolean {
  return currentStopId !== undefined && update.stopId === currentStopId;
}

// Build the upcoming-stops list and its passed counterpart.
//
// The TU prediction window is the authority for what is upcoming: its first entry is the next
// stop, so passedCount is that entry's sequence offset, and stops in the carried sequence range
// that the feed skipped (or left untimed) fill from the schedule. When a trip has no TU window
// at all, fall back to schedule-clock windowing with the configured grace. CTA stops its window
// after the current stop and often before the terminus, so neither is force-added here.
function buildStopWindow(
  deps: BuildVehicleDetailDeps,
  stops: StaticStop[],
  tu: TripUpdateInfo | undefined,
  currentStopId: string | undefined,
): { upcoming: UpcomingStop[]; passedCount: number; passedStops: PassedStop[] } {
  const firstSequence = stops[0]?.stopSequence ?? 0;

  if (!tu || tu.stopTimeUpdates.length === 0) {
    // No TU entity for the trip: schedule-clock windowing. A 120s grace keeps the boundary
    // stop from flickering out of the list the moment its scheduled time passes.
    const grace = 120;
    const start = stops.findIndex((stop) => stop.scheduled >= deps.nowSvc - grace);
    const from = start === -1 ? stops.length : start;
    const passedStops = stops.slice(0, from).map((stop) => toPassedStop(deps, stop));
    const upcoming = stops.slice(from, from + 8).map((stop) => toScheduledStop(deps, stop));
    return { upcoming, passedCount: from, passedStops };
  }

  const carried = new Map<number, StopTimePrediction>();
  for (const update of tu.stopTimeUpdates) {
    if (isCurrentStop(update, currentStopId)) continue;
    carried.set(update.stopSequence, update);
  }
  const sequences = [...carried.keys()].sort((a, b) => a - b);
  if (sequences.length === 0) {
    // The window carried only the current stop: nothing is left to predict.
    return {
      upcoming: [],
      passedCount: stops.length,
      passedStops: stops.map((stop) => toPassedStop(deps, stop)),
    };
  }

  const minSequence = sequences[0]!;
  const maxSequence = sequences[sequences.length - 1]!;
  const byStopId = new Map<string, StopTimePrediction>();
  for (const update of carried.values()) byStopId.set(update.stopId, update);

  // Only stops inside the carried window render; the feed's own window (which starts after the
  // current stop and usually omits the terminus) is authoritative for what counts as upcoming.
  const upcoming = stops
    .filter((stop) => stop.stopSequence >= minSequence && stop.stopSequence <= maxSequence)
    .slice(0, 8)
    .map((stop) => {
      const update = carried.get(stop.stopSequence) ?? byStopId.get(stop.stopId);
      // Per-stop predictions prefer the absolute arrival time, then the arrival delay; an
      // update with no timing leaves the stop scheduled.
      const predicted =
        update === undefined
          ? undefined
          : update.arrivalTime !== undefined
            ? unixToServiceSeconds(update.arrivalTime, deps.serviceDayStartSeconds, deps.timeZone)
            : update.arrivalDelay !== undefined
              ? stop.scheduled + update.arrivalDelay
              : undefined;
      return {
        stopId: stop.stopId,
        stopName: deps.stopNames.get(stop.stopId) ?? stop.stopId,
        stopSequence: stop.stopSequence,
        scheduled: stop.scheduled,
        predicted,
        source: predicted !== undefined ? ('predicted' as const) : ('scheduled' as const),
        ...coordsOf(deps, stop.stopId),
      };
    });
  const passedStops = stops
    .filter((stop) => stop.stopSequence < minSequence)
    .map((stop) => toPassedStop(deps, stop));
  return {
    upcoming,
    passedCount: Math.max(0, minSequence - firstSequence),
    passedStops,
  };
}

// Resolve the vehicle's live marker: coordinates from the feed, heading from the feed bearing
// or the implied toward/away direction used by the terminal map arrows.
function buildPosition(
  deps: BuildVehicleDetailDeps,
  vp: RealtimeSnapshot['vehiclePositions'][number] | undefined,
): VehicleDetail['position'] | undefined {
  if (!vp || vp.lat === undefined || vp.lon === undefined) return undefined;
  const point = { lat: vp.lat, lon: vp.lon };
  const towardTerminal = bearingDegrees(point, deps.center);
  const computed = (towardTerminal + (deps.run.status === 'departed' ? 180 : 0)) % 360;
  const headingDegrees = vp.bearing !== undefined ? vp.bearing : computed;
  return {
    lat: vp.lat,
    lon: vp.lon,
    headingDegrees: Math.round(headingDegrees * 10) / 10,
    observedAt: vp.timestamp,
    ageSeconds: Math.max(0, deps.generatedAt - vp.timestamp),
  };
}

// Assemble the full vehicle card response. Vehicle resolution reuses buildDepartures' chain
// (TU assignment for the trip, else block predecessor, else VP tripId inversion).
export function buildVehicleDetail(deps: BuildVehicleDetailDeps): VehicleDetail {
  const vehicleId = resolveVehicleForTrip(deps.rt, deps.blockChains, deps.tripId);
  const vp = vehicleId ? deps.rt.vehiclePositions.find((v) => v.vehicleId === vehicleId) : undefined;
  // Upcoming stops describe the trip the vehicle is currently operating. An incoming card's run
  // is the outbound trip being formed, but the bus is mid-inbound, so its leg is the current one;
  // for layover/departed cards the run itself is current.
  const stopsTripId = deps.run.currentTripId ?? deps.tripId;
  const stopsTripEnd = deps.tripEnds.get(stopsTripId);
  const stops = loadStops(deps, stopsTripId);
  const tu = deps.rt.tripUpdates.find((u) => u.tripId === stopsTripId);
  const timeline = buildStopWindow(deps, stops, tu, vp?.stopId);

  const nextTripId = deps.blockChains.nextTrip.get(deps.tripId);
  const nextTripEnd = nextTripId ? deps.tripEnds.get(nextTripId) : undefined;
  // The map's terminal anchor is the stop the vehicle is heading to: the inbound leg's last stop
  // while incoming, else the run's outbound first stop (the bay the vehicle forms).
  const anchorStopId = stopsTripEnd
    ? deps.run.status === 'incoming'
      ? stopsTripEnd.lastStopId
      : stopsTripEnd.firstStopId
    : undefined;
  const terminalStop = anchorStopId
    ? {
        stopId: anchorStopId,
        stopName: deps.stopNames.get(anchorStopId) ?? anchorStopId,
        ...coordsOf(deps, anchorStopId),
      }
    : undefined;

  return {
    terminalId: deps.terminal.id,
    tripId: deps.tripId,
    blockId: deps.blockId,
    vehicleId,
    routeId: deps.routeId,
    routeShortName: deps.routeShortName,
    color: deps.color,
    textColor: deps.textColor,
    destination: deps.destination,
    directionId: deps.directionId,
    position: buildPosition(deps, vp),
    status: deps.run.status,
    hold: deps.hold,
    overdueSeconds: deps.run.overdueSeconds,
    arrivalSource: deps.run.arrivalSource,
    nextTripId,
    nextTripDestination: nextTripEnd?.lastStopName,
    upcomingStops: timeline.upcoming,
    passedCount: timeline.passedCount,
    passedStops: timeline.passedStops,
    terminalStop,
  };
}

export interface BlockTimelineDeps {
  db: Database;
  blockId: string;
  serviceDate: string;
  nowSvc: number;
  activeServiceIds: Set<string>;
  tripEnds: ReadonlyMap<string, TripEnd>;
  routeStyleFor: (routeId: string) => RouteStyle;
  /** The engine's cross-refresh run ledger, keyed by tripId (departure facts + applied holds). */
  ledger: ReadonlyMap<string, RunRecord>;
}

// Build one block's trip chain for the active service date. Slice times come from trip_ends so
// the segment spans first departure to last arrival, and the `current` window survives a
// recorded departure (the bus is between departure and the far end even when running late).
export function buildBlockTimeline(deps: BlockTimelineDeps): BlockTimeline | undefined {
  const serviceList = Array.from(deps.activeServiceIds);
  // A block with no trip on an active service (or no active service at all) has no timeline.
  if (serviceList.length === 0) return undefined;
  const rows = prepared(
    deps.db,
    `SELECT bt.seq, bt.trip_id, bt.start_time, bt.route_id, t.direction_id
     FROM block_trips bt
     JOIN trips t ON t.trip_id = bt.trip_id
     WHERE bt.block_id = ? AND bt.service_id IN (${placeholders(serviceList.length)})
     ORDER BY bt.seq ASC`,
  ).all(deps.blockId, ...serviceList) as Array<{
    seq: number;
    trip_id: string;
    start_time: number;
    route_id: string;
    direction_id: number | null;
  }>;
  if (rows.length === 0) return undefined;

  const trips: BlockTrip[] = rows.map((row) => {
    const end = deps.tripEnds.get(row.trip_id);
    const style = deps.routeStyleFor(row.route_id);
    const start = end?.firstDeparture ?? row.start_time;
    const tripEnd = end?.lastArrival ?? start;
    const record = deps.ledger.get(row.trip_id);
    // A held departure is only flagged once the bus actually left under the locked hold.
    const held = record?.departureSeconds !== undefined && record?.hold !== undefined;
    const state = deps.nowSvc < start ? ('future' as const) : deps.nowSvc >= tripEnd ? ('past' as const) : ('current' as const);
    return {
      tripId: row.trip_id,
      routeId: row.route_id,
      routeShortName: style.shortName,
      color: style.color,
      textColor: style.textColor,
      directionId: row.direction_id ?? undefined,
      destination: end?.lastStopName ?? style.shortName,
      start,
      end: tripEnd,
      state,
      departedSeconds: record?.departureSeconds,
      held,
    };
  });

  return {
    blockId: deps.blockId,
    serviceDate: deps.serviceDate,
    nowSvc: deps.nowSvc,
    trips,
  };
}