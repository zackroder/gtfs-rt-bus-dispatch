import type { Database } from 'better-sqlite3';
import type { HoldOverride, Terminal } from '../../../shared/types';
import type { RealtimeSnapshot } from '../providers/types';
import { unixToServiceSeconds } from '../gtfs/time';
import { effectiveDeparture, expectedDepartureTime } from './dispatch';
import { outboundTrips } from './terminal';

export type VehicleState = 'incoming' | 'layover' | 'departed';

export const PAST_WINDOW_SECONDS = 30 * 60;

export interface RunRecord {
  arrivalSeconds?: number;
  departureSeconds?: number;
  hold?: HoldOverride;
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
  layoverProximityMeters: number;
  activeServiceIds: Set<string>;
  rt: RealtimeSnapshot;
  ledger: Map<string, RunRecord>;
}

export function buildBlockChains(
  db: Database,
): { nextTrip: Map<string, string>; prevTrip: Map<string, string> } {
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

  const matching = tripUpdate.stopTimeUpdates
    .filter((u) => stopIds.includes(u.stopId))
    .sort((a, b) => b.stopSequence - a.stopSequence);
  const update = matching[0];
  if (update) {
    if (update.arrivalTime !== undefined) {
      return {
        scheduled,
        predicted: unixToServiceSeconds(update.arrivalTime, serviceDayStartSeconds),
        known: true,
      };
    }
    if (update.arrivalDelay !== undefined) {
      return { scheduled, predicted: scheduled + update.arrivalDelay, known: true };
    }
  }
  if (tripUpdate.delay !== undefined) {
    return { scheduled, predicted: scheduled + tripUpdate.delay, known: true };
  }
  return { scheduled, predicted: scheduled, known: false };
}

export function departureObserved(
  rt: RealtimeSnapshot,
  tripId: string,
  stopIds: string[],
  scheduledDeparture: number,
  serviceDayStartSeconds: number,
): { departed: boolean; departureSeconds?: number } {
  const update = rt.tripUpdates.find((u) => u.tripId === tripId);
  if (update) {
    const terminal = update.stopTimeUpdates
      .filter((u) => stopIds.includes(u.stopId))
      .sort((a, b) => b.stopSequence - a.stopSequence)[0];
    if (terminal?.departureTime !== undefined && terminal.departureTime > 0) {
      return {
        departed: true,
        departureSeconds: unixToServiceSeconds(terminal.departureTime, serviceDayStartSeconds),
      };
    }
    if (terminal?.departureDelay !== undefined) {
      return { departed: true, departureSeconds: scheduledDeparture + terminal.departureDelay };
    }
  }
  const vehicle = rt.vehicles.find((v) => v.tripId === tripId);
  if (vehicle && vehicle.stopSequence !== undefined && vehicle.stopSequence > 0) {
    return { departed: true };
  }
  return { departed: false };
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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

  const { prevTrip } = buildBlockChains(db);

  const tripToVehicle = new Map<string, string>();
  for (const update of opts.rt.tripUpdates) {
    if (update.tripId && update.vehicleId) tripToVehicle.set(update.tripId, update.vehicleId);
  }
  for (const vehicle of opts.rt.vehicles) {
    if (vehicle.tripId && vehicle.vehicleId) tripToVehicle.set(vehicle.tripId, vehicle.vehicleId);
  }
  const vehicleToTrip = new Map<string, string>();
  for (const [trip, vehicle] of tripToVehicle) vehicleToTrip.set(vehicle, trip);

  const vehiclePositions = new Map<string, { lat?: number; lon?: number }>();
  for (const vehicle of opts.rt.vehicles) {
    if (vehicle.vehicleId) vehiclePositions.set(vehicle.vehicleId, { lat: vehicle.lat, lon: vehicle.lon });
  }

  const terminalCoords = db
    .prepare(
      `SELECT stop_id, lat, lon FROM stops WHERE stop_id IN (${opts.terminal.stopIds.map(() => '?').join(',')})`,
    )
    .all(...opts.terminal.stopIds) as Array<{ stop_id: string; lat: number; lon: number }>;

  const departures: OutboundDeparture[] = [];
  for (const ob of outbound) {
    const prevTripId = prevTrip.get(ob.tripId);
    const vehicleId =
      tripToVehicle.get(ob.tripId) ?? (prevTripId ? tripToVehicle.get(prevTripId) : undefined);
    const currentTrip = vehicleId ? vehicleToTrip.get(vehicleId) : undefined;

    let scheduledArrival = ob.departureTime;
    let predictedArrival = ob.departureTime;
    let hasArrivalInfo = false;
    if (vehicleId && (currentTrip === prevTripId || currentTrip === ob.tripId)) {
      const sourceTrip = currentTrip === prevTripId && prevTripId ? prevTripId : ob.tripId;
      const arrival = arrivalAtTerminal(
        db,
        opts.rt,
        sourceTrip,
        opts.terminal.stopIds,
        opts.serviceDayStartSeconds,
      );
      scheduledArrival = arrival.scheduled;
      predictedArrival = arrival.predicted;
      hasArrivalInfo = arrival.known;
    } else if (prevTripId) {
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
    const terminalArrival = record?.arrivalSeconds ?? (hasArrivalInfo ? predictedArrival : undefined);
    const edt = expectedDepartureTime(ob.departureTime, terminalArrival, opts.minRestSeconds);

    const departureObs = departureObserved(
      opts.rt,
      ob.tripId,
      opts.terminal.stopIds,
      ob.departureTime,
      opts.serviceDayStartSeconds,
    );
    const departedSeconds = record?.departureSeconds ?? departureObs.departureSeconds;
    const departed = record?.departureSeconds !== undefined || departureObs.departed;
    const onPrevLeg =
      vehicleId !== undefined && prevTripId !== undefined && currentTrip === prevTripId;
    const position = vehicleId ? vehiclePositions.get(vehicleId) : undefined;
    const withinBuffer =
      position && position.lat !== undefined && position.lon !== undefined
        ? terminalCoords.some(
            ({ lat, lon }) =>
              haversineMeters(position.lat!, position.lon!, lat, lon) <=
              opts.layoverProximityMeters,
          )
        : undefined;
    const atTerminal =
      withinBuffer === true ||
      (withinBuffer === undefined &&
        (predictedArrival <= opts.nowSvc || record?.arrivalSeconds !== undefined));
    let state: VehicleState;
    if (departed) state = 'departed';
    else if (onPrevLeg && predictedArrival > opts.nowSvc) state = 'incoming';
    else if (vehicleId !== undefined && atTerminal) state = 'layover';
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
