import type { Database } from 'better-sqlite3';
import type { Terminal } from '../../../shared/types';

export interface OutboundTripRow {
  tripId: string;
  stopId: string;
  departureTime: number;
}

export interface InboundTripRow {
  tripId: string;
  stopId: string;
  arrivalTime: number;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

export function outboundTrips(
  db: Database,
  routeId: string,
  stopIds: string[],
  activeServiceIds: Set<string>,
  fromSvc: number,
  toSvc: number,
): OutboundTripRow[] {
  const serviceList = Array.from(activeServiceIds);
  if (serviceList.length === 0) return [];
  const rows = db
    .prepare(
      `
      SELECT st.trip_id, st.stop_id, st.departure_time
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
  }>;
  return rows.map((r) => ({ tripId: r.trip_id, stopId: r.stop_id, departureTime: r.departure_time }));
}

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
  const rows = db
    .prepare(
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

export function outboundRoutesAtTerminal(
  db: Database,
  stopIds: string[],
  activeServiceIds: Set<string>,
  fromSvc: number,
  toSvc: number,
): string[] {
  const serviceList = Array.from(activeServiceIds);
  if (serviceList.length === 0) return [];
  const rows = db
    .prepare(
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

export function routeShortName(db: Database, routeId: string): string {
  const row = db
    .prepare(`SELECT short_name, long_name FROM routes WHERE route_id = ?`)
    .get(routeId) as { short_name: string; long_name: string } | undefined;
  if (!row) return routeId;
  return row.short_name || row.long_name || routeId;
}

export function autoDiscoverTerminals(db: Database, activeServiceIds: Set<string>): Terminal[] {
  const serviceList = Array.from(activeServiceIds);
  if (serviceList.length === 0) return [];
  const rows = db
    .prepare(
      `
      SELECT t.route_id, st.stop_id, st.stop_sequence, s.stop_name, s.lat, s.lon
      FROM trips t
      JOIN stop_times st ON st.trip_id = t.trip_id
      JOIN stops s ON s.stop_id = st.stop_id
      WHERE t.service_id IN (${placeholders(serviceList.length)})
      `,
    )
    .all(...serviceList) as Array<{
    route_id: string;
    stop_id: string;
    stop_sequence: number;
    stop_name: string;
    lat: number;
    lon: number;
  }>;

  const firstStopByRoute = new Map<string, string>();
  const stopMeta = new Map<string, { name: string; lat: number; lon: number }>();
  const byRoute = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (!stopMeta.has(row.stop_id)) {
      stopMeta.set(row.stop_id, { name: row.stop_name, lat: row.lat, lon: row.lon });
    }
    let stops = byRoute.get(row.route_id);
    if (!stops) {
      stops = new Map();
      byRoute.set(row.route_id, stops);
    }
    const current = stops.get(row.stop_id);
    if (current === undefined || row.stop_sequence < current) {
      stops.set(row.stop_id, row.stop_sequence);
    }
  }
  for (const [routeId, stops] of byRoute) {
    let bestStop = '';
    let bestSeq = Number.MAX_SAFE_INTEGER;
    for (const [stopId, seq] of stops) {
      if (seq < bestSeq) {
        bestSeq = seq;
        bestStop = stopId;
      }
    }
    firstStopByRoute.set(routeId, bestStop);
  }

  const candidates = new Map<string, { name: string; lat: number; lon: number; routeIds: Set<string> }>();
  for (const [routeId, stopId] of firstStopByRoute) {
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

  return Array.from(candidates.entries())
    .map(([stopId, candidate]) => ({
      id: stopId,
      name: candidate.name,
      stopIds: [stopId],
      routeIds: Array.from(candidate.routeIds).sort(),
    }))
    .filter((t) => (t.routeIds?.length ?? 0) > 0);
}
