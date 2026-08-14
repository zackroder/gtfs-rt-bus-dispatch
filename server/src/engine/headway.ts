import type { Database } from 'better-sqlite3';
import type { HoldOverride, Terminal, TripUpdateInfo } from '../../../shared/types';
import type { RealtimeSnapshot } from '../providers/types';
import { unixToServiceSeconds } from '../gtfs/time';
import { effectiveDeparture, expectedDepartureTime } from './dispatch';
import { outboundTrips } from './terminal';

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
  edt: number;
  departedSeconds?: number;
  state: VehicleState;
  hold?: HoldOverride;
  hasArrivalInfo: boolean;
  departureObs: { departed: boolean; departureSeconds?: number };
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
}

export function buildBlockChains(db: Database): BlockChains {
  const nextTrip = new Map<string, string>();
  const prevTrip = new Map<string, string>();
  const rows = db
    .prepare(`SELECT block_id, trip_id FROM block_trips ORDER BY block_id, seq`)
    .all() as Array<{ block_id: string; trip_id: string }>;
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

export function departureFact(
  tu: TripUpdateInfo,
  stopId: string,
  scheduled: number,
  serviceDayStartSeconds: number,
  nowSvc: number,
): { departed: boolean; departureSeconds?: number } {
  const terminal = tu.stopTimeUpdates
    .filter((u) => u.stopId === stopId)
    .sort((a, b) => b.stopSequence - a.stopSequence)[0];
  if (!terminal) {
    return { departed: tu.stopTimeUpdates.length > 0 };
  }
  if (terminal.departureTime !== undefined && terminal.departureTime > 0) {
    const departureSeconds = unixToServiceSeconds(terminal.departureTime, serviceDayStartSeconds);
    return { departed: departureSeconds <= nowSvc, departureSeconds };
  }
  if (terminal.departureDelay !== undefined) {
    const departureSeconds = scheduled + terminal.departureDelay;
    return { departed: departureSeconds <= nowSvc, departureSeconds };
  }
  return { departed: false };
}

export function arrivalFact(
  tu: TripUpdateInfo,
  stopId: string,
  scheduled: number,
  serviceDayStartSeconds: number,
): { predicted: number; known: boolean } {
  const matching = tu.stopTimeUpdates
    .filter((u) => u.stopId === stopId)
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

interface ArrivalAtStop {
  scheduled: number;
  predicted: number;
  known: boolean;
}

export function arrivalAtTerminal(
  db: Database,
  rt: RealtimeSnapshot,
  tripId: string,
  stopIds: string[],
  serviceDayStartSeconds: number,
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

  const tripUpdate = rt.tripUpdates.find((u) => u.tripId === tripId);
  if (!tripUpdate) return { scheduled, predicted: scheduled, known: false };

  const fact = arrivalFact(tripUpdate, last.stop_id, scheduled, serviceDayStartSeconds);
  return { scheduled, predicted: fact.predicted, known: fact.known };
}

export function departureObserved(
  rt: RealtimeSnapshot,
  tripId: string,
  stopIds: string[],
  scheduledDeparture: number,
  serviceDayStartSeconds: number,
  nowSvc: number,
): { departed: boolean; departureSeconds?: number } {
  const update = rt.tripUpdates.find((u) => u.tripId === tripId);
  if (!update || update.stopTimeUpdates.length === 0) return { departed: false };
  const terminal = update.stopTimeUpdates
    .filter((u) => stopIds.includes(u.stopId))
    .sort((a, b) => b.stopSequence - a.stopSequence)[0];
  if (!terminal) return { departed: true };
  return departureFact(update, terminal.stopId, scheduledDeparture, serviceDayStartSeconds, nowSvc);
}

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
    if (vp.vehicleId && vp.tripId) vpTripByVehicle.set(vp.vehicleId, vp.tripId);
  }

  const departures: OutboundDeparture[] = [];
  for (const ob of outbound) {
    const prevTripId = prevTrip.get(ob.tripId);
    const vehicleId =
      tripToVehicle.get(ob.tripId) ?? (prevTripId ? tripToVehicle.get(prevTripId) : undefined);
    const currentTrip = vehicleId
      ? (vpTripByVehicle.get(vehicleId) ?? vehicleToTrip.get(vehicleId))
      : undefined;

    let scheduledArrival = ob.departureTime;
    let predictedArrival = ob.departureTime;
    let hasArrivalInfo = false;
    if (prevTripId) {
      const arrival = arrivalAtTerminal(
        db,
        opts.rt,
        prevTripId,
        opts.terminal.stopIds,
        opts.serviceDayStartSeconds,
      );
      scheduledArrival = arrival.scheduled;
      predictedArrival = arrival.predicted;
      hasArrivalInfo = arrival.known;
    }

    const record = opts.ledger.get(ob.tripId);
    const onPrevLeg =
      vehicleId !== undefined && prevTripId !== undefined && currentTrip === prevTripId;
    const onOutboundLeg = vehicleId !== undefined && currentTrip === ob.tripId;

    const departureObs = departureObserved(
      opts.rt,
      ob.tripId,
      opts.terminal.stopIds,
      ob.departureTime,
      opts.serviceDayStartSeconds,
      opts.nowSvc,
    );
    const departed = record?.departureSeconds !== undefined || departureObs.departed;
    const departedSeconds = record?.departureSeconds ?? (departed ? departureObs.departureSeconds : undefined);

    const terminalArrival =
      record?.arrivalSeconds ?? (onPrevLeg && hasArrivalInfo ? predictedArrival : undefined);
    const ctaDeparture = departureObs.departureSeconds;
    const edt = Math.max(
      expectedDepartureTime(ob.departureTime, terminalArrival, opts.minRestSeconds),
      ctaDeparture !== undefined ? ctaDeparture : Number.NEGATIVE_INFINITY,
    );

    const arrivedAtTerminal =
      onOutboundLeg ||
      (onPrevLeg && hasArrivalInfo && predictedArrival <= opts.nowSvc) ||
      record?.arrivalSeconds !== undefined;
    let state: VehicleState;
    if (departed) state = 'departed';
    else if (onPrevLeg && !arrivedAtTerminal) state = 'incoming';
    else if (arrivedAtTerminal) state = 'layover';
    else state = 'departed';

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
      edt,
      departedSeconds,
      state,
      hold: record?.hold,
      hasArrivalInfo,
      departureObs,
    });
  }

  departures.sort(
    (a, b) => effectiveDeparture(a) - effectiveDeparture(b) || a.tripId.localeCompare(b.tripId),
  );
  return departures;
}
