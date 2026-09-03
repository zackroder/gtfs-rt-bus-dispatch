import type { Database } from 'better-sqlite3';
import type { Terminal } from '../../../shared/types';
import { prepared } from '../db/prepare';

// Terminal queries separate the first stop of outbound service from the last stop of
// inbound service. This lets one configured terminal represent both arriving and departing buses.
export interface OutboundTripRow {
  tripId: string;
  stopId: string;
  departureTime: number;
  headsign?: string;
}

export interface InboundTripRow {
  tripId: string;
  stopId: string;
  arrivalTime: number;
}

function placeholders(count: number): string {
  // Parameterized placeholders keep dynamic IN lists safe without interpolating IDs.
  return Array.from({ length: count }, () => '?').join(',');
}

// Return scheduled outbound trips serving the terminal during the requested service window.
// The service-list prefix of these queries changes per service date, but that is rare
// relative to the per-refresh call rate; the placeholder count keeps one statement per shape.
export function outboundTrips(
  db: Database,
  routeId: string,
  stopIds: string[],
  activeServiceIds: Set<string>,
  fromSvc: number,
  toSvc: number,
): OutboundTripRow[] {
  const serviceList = Array.from(activeServiceIds);
  // No active service means no schedule should leak into the current terminal view.
  if (serviceList.length === 0) return [];
  const rows = prepared(
    db,
    `
      SELECT st.trip_id, st.stop_id, st.departure_time, t.headsign
      FROM stop_times st
      JOIN trips t ON t.trip_id = st.trip_id AND t.route_id = ? AND t.service_id IN (${placeholders(serviceList.length)})
      WHERE st.stop_id IN (${placeholders(stopIds.length)})
        AND st.pickup_type != 1
        AND st.departure_time >= ? AND st.departure_time <= ?
        AND st.stop_sequence = (SELECT MIN(stop_sequence) FROM stop_times s2 WHERE s2.trip_id = st.trip_id)
      `,
  )
    .all(routeId, ...serviceList, ...stopIds, fromSvc, toSvc) as Array<{
    trip_id: string;
    stop_id: string;
    departure_time: number;
    headsign: string | null;
  }>;
  return rows.map((r) => ({
    tripId: r.trip_id,
    stopId: r.stop_id,
    departureTime: r.departure_time,
    headsign: r.headsign ?? undefined,
  }));
}

// Return scheduled inbound trips whose final stop is this terminal.
export function inboundTrips(
  db: Database,
  routeId: string,
  stopIds: string[],
  activeServiceIds: Set<string>,
  fromSvc: number,
  toSvc: number,
): InboundTripRow[] {
  const serviceList = Array.from(activeServiceIds);
  if (serviceList.length === 0) return [];
  const rows = prepared(
    db,
    `
      SELECT st.trip_id, st.stop_id, st.arrival_time
      FROM stop_times st
      JOIN trips t ON t.trip_id = st.trip_id AND t.route_id = ? AND t.service_id IN (${placeholders(serviceList.length)})
      WHERE st.stop_id IN (${placeholders(stopIds.length)})
        AND st.drop_off_type != 1
        AND st.arrival_time >= ? AND st.arrival_time <= ?
        AND st.stop_sequence = (SELECT MAX(stop_sequence) FROM stop_times s2 WHERE s2.trip_id = st.trip_id)
      `,
  )
    .all(routeId, ...serviceList, ...stopIds, fromSvc, toSvc) as Array<{
    trip_id: string;
    stop_id: string;
    arrival_time: number;
  }>;
  return rows.map((r) => ({ tripId: r.trip_id, stopId: r.stop_id, arrivalTime: r.arrival_time }));
}

// Find routes with outbound departures at a terminal in the requested service window.
export function outboundRoutesAtTerminal(
  db: Database,
  stopIds: string[],
  activeServiceIds: Set<string>,
  fromSvc: number,
  toSvc: number,
): string[] {
  const serviceList = Array.from(activeServiceIds);
  if (serviceList.length === 0) return [];
  const rows = prepared(
    db,
    `
      SELECT DISTINCT t.route_id
      FROM stop_times st
      JOIN trips t ON t.trip_id = st.trip_id AND t.service_id IN (${placeholders(serviceList.length)})
      WHERE st.stop_id IN (${placeholders(stopIds.length)})
        AND st.pickup_type != 1
        AND st.departure_time >= ? AND st.departure_time <= ?
        AND st.stop_sequence = (SELECT MIN(stop_sequence) FROM stop_times s2 WHERE s2.trip_id = st.trip_id)
      `,
  )
    .all(...serviceList, ...stopIds, fromSvc, toSvc) as Array<{ route_id: string }>;
  return rows.map((r) => r.route_id).sort();
}

export interface RouteStyle {
  shortName: string;
  longName?: string;
  color?: string;
  textColor?: string;
}

// Read the display metadata for a route, falling back to its identifier when static data is absent.
export function routeStyle(db: Database, routeId: string): RouteStyle {
  // GTFS colors are passed through unchanged; the UI owns presentation of the six-digit values.
  const row = prepared(db, `SELECT short_name, long_name, color, text_color FROM routes WHERE route_id = ?`)
    .get(routeId) as
    | { short_name: string; long_name: string; color: string | null; text_color: string | null }
    | undefined;
  return {
    shortName: row?.short_name || row?.long_name || routeId,
    longName: row?.long_name || undefined,
    color: row?.color ?? undefined,
    textColor: row?.text_color ?? undefined,
  };
}

// Return the display short name used by older callers that need only one label.
export function routeShortName(db: Database, routeId: string): string {
  return routeStyle(db, routeId).shortName;
}

// Infer terminal candidates from the modal endpoints of active route/direction schedules.
export function autoDiscoverTerminals(db: Database, activeServiceIds: Set<string>): Terminal[] {
  const serviceList = Array.from(activeServiceIds);
  if (serviceList.length === 0) return [];
  const rows = db
    .prepare(
      `
      SELECT t.route_id, t.direction_id, t.trip_id, st.stop_id, st.stop_sequence, s.stop_name, s.lat, s.lon
      FROM trips t
      JOIN stop_times st ON st.trip_id = t.trip_id
      JOIN stops s ON s.stop_id = st.stop_id
      WHERE t.service_id IN (${placeholders(serviceList.length)})
      `,
    )
    .all(...serviceList) as Array<{
    route_id: string;
    direction_id: number | null;
    trip_id: string;
    stop_id: string;
    stop_sequence: number;
    stop_name: string;
    lat: number;
    lon: number;
  }>;

  const stopMeta = new Map<string, { name: string; lat: number; lon: number }>();
  // A modal first/last stop per route and direction is more robust than assuming every trip
  // uses the same endpoint, especially when schedules contain short turns or variants.
  const tripFirstStop = new Map<string, { stopId: string; routeId: string; dir: string; seq: number }>();
  const tripLastStop = new Map<string, { stopId: string; routeId: string; dir: string; seq: number }>();
  for (const row of rows) {
    if (!stopMeta.has(row.stop_id)) {
      stopMeta.set(row.stop_id, { name: row.stop_name, lat: row.lat, lon: row.lon });
    }
    const dir = row.direction_id === null ? '' : String(row.direction_id);
    const current = tripFirstStop.get(row.trip_id);
    if (!current || row.stop_sequence < current.seq) {
      tripFirstStop.set(row.trip_id, {
        stopId: row.stop_id,
        routeId: row.route_id,
        dir,
        seq: row.stop_sequence,
      });
    }
    const last = tripLastStop.get(row.trip_id);
    if (!last || row.stop_sequence > last.seq) {
      tripLastStop.set(row.trip_id, {
        stopId: row.stop_id,
        routeId: row.route_id,
        dir,
        seq: row.stop_sequence,
      });
    }
  }

  function countByKey(stops: Map<string, { stopId: string; routeId: string; dir: string; seq: number }>) {
    const counts = new Map<string, Map<string, number>>();
    for (const s of stops.values()) {
      const key = `${s.routeId}:${s.dir}`;
      let byStop = counts.get(key);
      if (!byStop) {
        byStop = new Map();
        counts.set(key, byStop);
      }
      byStop.set(s.stopId, (byStop.get(s.stopId) ?? 0) + 1);
    }
    return counts;
  }

  function modal(counts: Map<string, Map<string, number>>): Map<string, string | undefined> {
    // Select the most common endpoint for each route/direction, with query order providing
    // a stable tie result for otherwise equivalent candidates.
    const result = new Map<string, string | undefined>();
    for (const [key, byStop] of counts) {
      let best: string | undefined;
      let bestCount = -1;
      for (const [stopId, count] of byStop) {
        if (count > bestCount) {
          bestCount = count;
          best = stopId;
        }
      }
      result.set(key, best);
    }
    return result;
  }

  const firstCounts = countByKey(tripFirstStop);
  const lastCounts = countByKey(tripLastStop);
  const modalFirst = modal(firstCounts);
  const modalLast = modal(lastCounts);

  const stopsByRoute = new Map<string, Set<string>>();
  for (const [key, stopId] of modalFirst) {
    const routeId = key.slice(0, key.lastIndexOf(':'));
    if (!stopId || routeId === '') continue;
    let stops = stopsByRoute.get(routeId);
    if (!stops) {
      stops = new Set();
      stopsByRoute.set(routeId, stops);
    }
    stops.add(stopId);
  }
  for (const [key, stopId] of modalLast) {
    const routeId = key.slice(0, key.lastIndexOf(':'));
    if (!stopId || routeId === '') continue;
    let stops = stopsByRoute.get(routeId);
    if (!stops) {
      stops = new Set();
      stopsByRoute.set(routeId, stops);
    }
    stops.add(stopId);
  }

  const candidates = new Map<string, { name: string; lat: number; lon: number; routeIds: Set<string> }>();
  for (const [routeId, stopIds] of stopsByRoute) {
    for (const stopId of stopIds) {
      let candidate = candidates.get(stopId);
      if (!candidate) {
        const meta = stopMeta.get(stopId);
        candidate = {
          name: meta?.name ?? stopId,
          lat: meta?.lat ?? 0,
          lon: meta?.lon ?? 0,
          routeIds: new Set(),
        };
        candidates.set(stopId, candidate);
      }
      candidate.routeIds.add(routeId);
    }
  }

  return Array.from(candidates.entries())
    .map(([stopId, candidate]) => ({
      id: stopId,
      name: candidate.name,
      stopIds: [stopId],
      routeIds: Array.from(candidate.routeIds).sort(),
    }))
    .filter((t) => (t.routeIds?.length ?? 0) > 0);
}
