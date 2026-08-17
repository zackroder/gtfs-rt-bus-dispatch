import type { Database } from 'better-sqlite3';
import type { HoldOverride, Terminal, TripUpdateInfo } from '../../../shared/types';
import type { RealtimeSnapshot } from '../providers/types';
import { unixToServiceSeconds } from '../gtfs/time';
import { effectiveDeparture, expectedDepartureTime } from './dispatch';
import { outboundTrips } from './terminal';

// Headway construction combines static departure order, realtime predictions, and persisted
// VP/ TU run facts into the records consumed by the dispatch decision function.
export type VehicleState = 'incoming' | 'layover' | 'departed';

export const PAST_WINDOW_SECONDS = 30 * 60;

export type FactSource = 'vp' | 'tu';

export interface RunRecord {
  arrivalSeconds?: number;
  arrivalSource?: FactSource;
  departureSeconds?: number;
  departureSource?: FactSource;
  hold?: HoldOverride;
}

export interface BlockChains {
  nextTrip: Map<string, string>;
  prevTrip: Map<string, string>;
}

export interface TripEnd {
  firstStopId: string;
  firstStopSequence: number;
  firstDeparture: number;
  lastStopId: string;
  lastStopSequence: number;
  lastArrival: number;
  lastStopName: string;
}

export interface OutboundDeparture {
  tripId: string;
  routeId: string;
  vehicleId?: string;
  prevTripId?: string;
  headsign?: string;
  scheduledDeparture: number;
  scheduledArrival: number;
  predictedArrival: number;
  terminalArrival?: number;
  arrivalSource?: 'observed' | 'estimated';
  arrivalForEdt?: number;
  edt: number;
  departedSeconds?: number;
  state: VehicleState;
  hold?: HoldOverride;
  hasArrivalInfo: boolean;
}

export interface BuildDeparturesOptions {
  routeId: string;
  terminal: Terminal;
  nowSvc: number;
  lookaheadSeconds: number;
  serviceDayStartSeconds: number;
  minRestSeconds: number;
  activeServiceIds: Set<string>;
  rt: RealtimeSnapshot;
  ledger: Map<string, RunRecord>;
  blockChains?: BlockChains;
  tripUpdatesById?: ReadonlyMap<string, TripUpdateInfo>;
  arrivalCache?: Map<string, ArrivalAtStop>;
  // Per-vehicle terminal posture from the geometric fact pass, for layover classification.
  vpTerminalState?: ReadonlyMap<string, VehicleTerminalState>;
  scheduleArmGraceSeconds?: number;
}

// What the geometric fact pass observed about a vehicle near a terminal this refresh.
export interface VehicleTerminalState {
  inBuffer: boolean;
  parked: boolean;
  distToTerminalM?: number;
  armTripId?: string;
  layoverTripId?: string;
}

// Build predecessor/successor links for trips assigned to the same block.
export function buildBlockChains(db: Database, activeServiceIds?: Set<string>): BlockChains {
  const nextTrip = new Map<string, string>();
  const prevTrip = new Map<string, string>();
  const serviceList = activeServiceIds ? Array.from(activeServiceIds) : [];
  if (activeServiceIds && serviceList.length === 0) return { nextTrip, prevTrip };
  // An optional service filter keeps block relationships from crossing into another service date.
  const filter = serviceList.length > 0
    ? `WHERE service_id IN (${serviceList.map(() => '?').join(',')})`
    : '';
  const rows = db
    .prepare(`SELECT block_id, trip_id FROM block_trips ${filter} ORDER BY block_id, seq`)
    .all(...serviceList) as Array<{ block_id: string; trip_id: string }>;
  let lastBlock = '';
  let lastTrip = '';
  for (const row of rows) {
    if (row.block_id === lastBlock && lastTrip !== '') {
      nextTrip.set(lastTrip, row.trip_id);
      prevTrip.set(row.trip_id, lastTrip);
    }
    lastBlock = row.block_id;
    lastTrip = row.trip_id;
  }
  return { nextTrip, prevTrip };
}

// Cache each trip's first and last scheduled stop for VP state inference and display labels.
export function buildTripEnds(db: Database): Map<string, TripEnd> {
  const rows = db
    .prepare(
      `SELECT e.trip_id, f.stop_id AS first_stop_id, f.stop_sequence AS first_stop_sequence,
              COALESCE(f.departure_time, f.arrival_time) AS first_departure,
              l.stop_id AS last_stop_id, l.stop_sequence AS last_stop_sequence,
              COALESCE(l.arrival_time, l.departure_time) AS last_arrival,
              s.stop_name AS last_stop_name
       FROM (
         SELECT trip_id, MIN(stop_sequence) AS min_seq, MAX(stop_sequence) AS max_seq
         FROM stop_times GROUP BY trip_id
       ) e
       JOIN stop_times f ON f.trip_id = e.trip_id AND f.stop_sequence = e.min_seq
       JOIN stop_times l ON l.trip_id = e.trip_id AND l.stop_sequence = e.max_seq
       JOIN stops s ON s.stop_id = l.stop_id`,
    )
    .all() as Array<{
    trip_id: string;
    first_stop_id: string;
    first_stop_sequence: number;
    first_departure: number;
    last_stop_id: string;
    last_stop_sequence: number;
    last_arrival: number;
    last_stop_name: string;
  }>;
  const ends = new Map<string, TripEnd>();
  for (const r of rows) {
    ends.set(r.trip_id, {
      firstStopId: r.first_stop_id,
      firstStopSequence: r.first_stop_sequence,
      firstDeparture: r.first_departure,
      lastStopId: r.last_stop_id,
      lastStopSequence: r.last_stop_sequence,
      lastArrival: r.last_arrival,
      lastStopName: r.last_stop_name,
    });
  }
  return ends;
}

// Derive one terminal arrival prediction using the most specific available TU field.
export function arrivalFact(
  tu: TripUpdateInfo,
  stopId: string,
  stopSequence: number,
  scheduled: number,
  serviceDayStartSeconds: number,
): { predicted: number; known: boolean } {
  // Prefer an absolute predicted arrival, then stop delay, then trip delay. A missing value
  // remains unknown rather than pretending the schedule is an observed arrival.
  const matching = tu.stopTimeUpdates
    .filter((u) => u.stopId === stopId || u.stopSequence === stopSequence)
    .sort((a, b) => b.stopSequence - a.stopSequence);
  const update = matching[0];
  if (update?.arrivalTime !== undefined) {
    return {
      predicted: unixToServiceSeconds(update.arrivalTime, serviceDayStartSeconds),
      known: true,
    };
  }
  if (update?.arrivalDelay !== undefined) {
    return { predicted: scheduled + update.arrivalDelay, known: true };
  }
  if (tu.delay !== undefined) {
    return { predicted: scheduled + tu.delay, known: true };
  }
  return { predicted: scheduled, known: false };
}

export interface ArrivalAtStop {
  scheduled: number;
  predicted: number;
  known: boolean;
}

// Look up a trip's scheduled terminal arrival and apply its realtime prediction when available.
export function arrivalAtTerminal(
  db: Database,
  rt: RealtimeSnapshot,
  tripId: string,
  stopIds: string[],
  serviceDayStartSeconds: number,
  tripUpdatesById?: ReadonlyMap<string, TripUpdateInfo>,
): ArrivalAtStop {
  const placeholders = stopIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT stop_id, arrival_time, departure_time, stop_sequence
       FROM stop_times WHERE trip_id = ? AND stop_id IN (${placeholders})`,
    )
    .all(tripId, ...stopIds) as Array<{
    stop_id: string;
    arrival_time: number;
    departure_time: number;
    stop_sequence: number;
  }>;
  if (rows.length === 0) return { scheduled: 0, predicted: 0, known: false };
  rows.sort((a, b) => a.stop_sequence - b.stop_sequence);
  const last = rows[rows.length - 1]!;
  const scheduled = last.arrival_time ?? last.departure_time;

  const tripUpdate = tripUpdatesById?.get(tripId) ?? rt.tripUpdates.find((u) => u.tripId === tripId);
  // A terminal prediction is only useful when the TU identifies the corresponding trip.
  if (!tripUpdate) return { scheduled, predicted: scheduled, known: false };

  const fact = arrivalFact(
    tripUpdate,
    last.stop_id,
    last.stop_sequence,
    scheduled,
    serviceDayStartSeconds,
  );
  return { scheduled, predicted: fact.predicted, known: fact.known };
}

// Construct ordered outbound departures with vehicle assignment, state, arrival, and EDT fields.
export function buildDepartures(db: Database, opts: BuildDeparturesOptions): OutboundDeparture[] {
  const outbound = outboundTrips(
    db,
    opts.routeId,
    opts.terminal.stopIds,
    opts.activeServiceIds,
    opts.nowSvc - PAST_WINDOW_SECONDS,
    opts.nowSvc + opts.lookaheadSeconds,
  );
  if (outbound.length === 0) return [];

  const { prevTrip } = opts.blockChains ?? buildBlockChains(db);

  const tripToVehicle = new Map<string, string>();
  for (const update of opts.rt.tripUpdates) {
    if (update.tripId && update.vehicleId) tripToVehicle.set(update.tripId, update.vehicleId);
  }
  const vehicleToTrip = new Map<string, string>();
  for (const [trip, vehicle] of tripToVehicle) vehicleToTrip.set(vehicle, trip);
  const vpTripByVehicle = new Map<string, string>();
  for (const vp of opts.rt.vehiclePositions) {
    // VP is the stronger assignment signal when TU and VP disagree; TU remains a fallback
    // for feeds that omit a trip from the vehicle-position entity.
    if (vp.vehicleId && vp.tripId) {
      vpTripByVehicle.set(vp.vehicleId, vp.tripId);
      if (!tripToVehicle.has(vp.tripId)) tripToVehicle.set(vp.tripId, vp.vehicleId);
    }
  }

  const departures: OutboundDeparture[] = [];
  for (const ob of outbound) {
    const prevTripId = prevTrip.get(ob.tripId);
    const vehicleId =
      tripToVehicle.get(ob.tripId) ?? (prevTripId ? tripToVehicle.get(prevTripId) : undefined);
    const currentTrip = vehicleId
      ? (vpTripByVehicle.get(vehicleId) ?? vehicleToTrip.get(vehicleId))
      : undefined;
    const currentTripFromVp = vehicleId !== undefined && vpTripByVehicle.has(vehicleId);

    let scheduledArrival = ob.departureTime;
    let predictedArrival = ob.departureTime;
    let hasArrivalInfo = false;
    if (prevTripId) {
      // The outbound bus may still be on its previous block leg. Its terminal arrival is the
      // input to EDT and to the incoming/layover classification.
      const cacheKey = `${prevTripId}|${opts.terminal.stopIds.join(',')}`;
      const arrival = opts.arrivalCache?.get(cacheKey) ?? arrivalAtTerminal(
        db,
        opts.rt,
        prevTripId,
        opts.terminal.stopIds,
        opts.serviceDayStartSeconds,
        opts.tripUpdatesById,
      );
      opts.arrivalCache?.set(cacheKey, arrival);
      scheduledArrival = arrival.scheduled;
      predictedArrival = arrival.predicted;
      hasArrivalInfo = arrival.known;
    }

    const record = opts.ledger.get(ob.tripId);
    const onPrevLeg =
      vehicleId !== undefined && prevTripId !== undefined && currentTrip === prevTripId;
    const onOutboundLeg = currentTripFromVp && currentTrip === ob.tripId;
    // Geometric posture: the vehicle is sitting inside the terminal buffer this refresh. This
    // is the timely signal that upgrades an incoming bus to layover before the VP flip confirms
    // it, and it is independent of both block chains and TU stop predictions.
    const terminalState = vehicleId ? opts.vpTerminalState?.get(vehicleId) : undefined;
    // A vehicle parked inside the terminal buffer is the timely geometric arrival signal. The
    // scheduled-arm fallback covers a bus that reached the terminal area but never registered as
    // stationary (e.g. staging just beyond the stop or a feed gap), once its scheduled arrival
    // has passed by the grace window.
    const parkedAtTerminal = terminalState?.inBuffer === true && terminalState.parked === true;
    const grace = opts.scheduleArmGraceSeconds ?? 120;
    const scheduledArm =
      terminalState?.inBuffer === true &&
      !terminalState.parked &&
      scheduledArrival !== undefined &&
      scheduledArrival + grace <= opts.nowSvc;

    const departed = record?.departureSeconds !== undefined;
    const departedSeconds = record?.departureSeconds;

    const terminalArrival = record?.arrivalSeconds;
    const arrivalSource = terminalArrival !== undefined
      ? 'observed'
      : parkedAtTerminal || scheduledArm || hasArrivalInfo
        ? 'estimated'
        : undefined;
    const arrivalForEdt = terminalArrival ?? (parkedAtTerminal || scheduledArm
      ? Math.max(scheduledArrival, opts.nowSvc)
      : onPrevLeg && hasArrivalInfo
        ? predictedArrival
        : undefined);
    // Observed VP arrival wins over an estimate; while parked the bus is physically there, so its
    // estimated arrival is at least the current time. Estimates are used for EDT only while the
    // bus is demonstrably still on the previous leg.
    const edt = expectedDepartureTime(ob.departureTime, arrivalForEdt, opts.minRestSeconds);

    const arrivedAtTerminal =
      onOutboundLeg ||
      parkedAtTerminal ||
      scheduledArm ||
      (onPrevLeg && hasArrivalInfo && predictedArrival <= opts.nowSvc) ||
      record?.arrivalSeconds !== undefined;
    let state: VehicleState;
    if (departed) state = 'departed';
    else if (onPrevLeg && !arrivedAtTerminal) state = 'incoming';
    else if (arrivedAtTerminal) state = 'layover';
    else state = 'departed';
    // A bus with no reliable live assignment is treated as departed rather than shown as waiting;
    // this avoids presenting an untracked vehicle as an actionable layover.

    departures.push({
      tripId: ob.tripId,
      routeId: opts.routeId,
      vehicleId,
      prevTripId,
      headsign: ob.headsign,
      scheduledDeparture: ob.departureTime,
      scheduledArrival,
      predictedArrival,
      terminalArrival,
      arrivalSource,
      arrivalForEdt,
      edt,
      departedSeconds,
      state,
      hold: record?.hold,
      hasArrivalInfo,
    });
  }

  departures.sort(
    // Holds alter effective ordering, and trip ID breaks ties deterministically.
    (a, b) => effectiveDeparture(a) - effectiveDeparture(b) || a.tripId.localeCompare(b.tripId),
  );
  return departures;
}
