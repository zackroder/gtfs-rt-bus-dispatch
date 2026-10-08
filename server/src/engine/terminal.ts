import type { Database } from 'better-sqlite3';
import type { Terminal } from '../../../shared/types';
import { prepared } from '../db/prepare';
import { activeServiceIds } from '../gtfs/time';

// A route/direction endpoint must be served by at least this many trips to become a terminal.
// Filters one-off deadheads and short-turns while keeping scheduled time-of-day variants (e.g.
// the #9 southbound 104 Vincennes morning vs. 95 Beverly midday split).
export const DISCOVERY_MIN_TRIPS = 2;

// Terminal activity looks back this far so a bus that just left keeps its terminal on the board
// at the current moment; the forward edge is the configured lookahead.
export const ACTIVITY_LOOKBACK_SECONDS = 30 * 60;

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

// Advance a YYYYMMDD key by whole days using UTC arithmetic so month/year boundaries are exact.
function shiftDateKey(dateKey: string, days: number): string {
  const year = Number(dateKey.slice(0, 4));
  const month = Number(dateKey.slice(4, 6));
  const day = Number(dateKey.slice(6, 8));
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

// Union active service IDs across `days` service dates starting at `startDate`. Discovery uses a
// week so day-of-week-only variants (e.g. weekend terminals) are found, not just today's services.
export function discoveryServiceIds(db: Database, startDate: string, days: number): Set<string> {
  const union = new Set<string>();
  for (let offset = 0; offset < days; offset++) {
    for (const id of activeServiceIds(db, shiftDateKey(startDate, offset))) union.add(id);
  }
  return union;
}

// Routes with a scheduled endpoint event at any of `stopIds` inside the window, keyed by stop id.
// A route is active at a stop when a trip departs as its first stop (pickup_type != 1) or arrives
// as its last stop (drop_off_type != 1); the inbound-arrival side is what makes a terminal that
// currently only receives buses (e.g. a midday layover variant) show as active. Batched over all
// stops so the home endpoint issues one query rather than one per terminal.
export function activeRoutesByStop(
  db: Database,
  stopIds: string[],
  activeServiceIds: Set<string>,
  fromSvc: number,
  toSvc: number,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const serviceList = Array.from(activeServiceIds);
  if (serviceList.length === 0 || stopIds.length === 0) return result;
  // A per-row correlated MIN/MAX over stop_times is O(candidate rows × lookups) and made the
  // all-terminal home query take tens of seconds. Bounding every trip once in a CTE is a single
  // grouped pass (the whole-table bound beats a candidate-trip prefilter on this feed).
  const rows = prepared(
    db,
    `
      WITH trip_bounds AS (
        SELECT trip_id, MIN(stop_sequence) AS first_seq, MAX(stop_sequence) AS last_seq
        FROM stop_times GROUP BY trip_id
      )
      SELECT DISTINCT st.stop_id, t.route_id
      FROM stop_times st
      JOIN trip_bounds b ON b.trip_id = st.trip_id
      JOIN trips t ON t.trip_id = st.trip_id AND t.service_id IN (${placeholders(serviceList.length)})
      WHERE st.stop_id IN (${placeholders(stopIds.length)})
        AND (
          (st.pickup_type != 1 AND st.stop_sequence = b.first_seq
             AND st.departure_time >= ? AND st.departure_time <= ?)
          OR
          (st.drop_off_type != 1 AND st.stop_sequence = b.last_seq
             AND st.arrival_time >= ? AND st.arrival_time <= ?)
        )
      `,
  ).all(...serviceList, ...stopIds, fromSvc, toSvc, fromSvc, toSvc) as Array<{
    stop_id: string;
    route_id: string;
  }>;
  for (const row of rows) {
    let routes = result.get(row.stop_id);
    if (!routes) {
      routes = new Set();
      result.set(row.stop_id, routes);
    }
    routes.add(row.route_id);
  }
  return result;
}

// Union the per-stop activity for one terminal's stop list into a sorted route list.
export function activeRoutesAtTerminal(
  db: Database,
  stopIds: string[],
  activeServiceIds: Set<string>,
  fromSvc: number,
  toSvc: number,
): string[] {
  const byStop = activeRoutesByStop(db, stopIds, activeServiceIds, fromSvc, toSvc);
  const routes = new Set<string>();
  for (const stopId of stopIds) {
    for (const routeId of byStop.get(stopId) ?? []) routes.add(routeId);
  }
  return Array.from(routes).sort();
}

// Terminal ids with at least one route endpoint event in the window. Used to evaluate the whole
// active board every refresh (not just viewed terminals) so recommendations and run facts are
// recorded even when nobody has the app open.
export function activeTerminalIds(
  db: Database,
  terminals: Terminal[],
  activeServiceIds: Set<string>,
  fromSvc: number,
  toSvc: number,
): Set<string> {
  const allStopIds = Array.from(new Set(terminals.flatMap((terminal) => terminal.stopIds)));
  const byStop = activeRoutesByStop(db, allStopIds, activeServiceIds, fromSvc, toSvc);
  const active = new Set<string>();
  for (const terminal of terminals) {
    for (const stopId of terminal.stopIds) {
      if ((byStop.get(stopId)?.size ?? 0) > 0) {
        active.add(terminal.id);
        break;
      }
    }
  }
  return active;
}

// Restrict a discovered terminal list to the focused routes: keep each terminal but drop routes
// outside the focus, and drop terminals that then serve no focused route. An empty focus keeps
// every route (local dev and pre-focus behavior). The engine's wanted set derives from
// config.terminals, so scoping discovery here scopes facts, decisions, logs, and the menu.
export function filterTerminalsByFocus(terminals: Terminal[], focusRouteIds: string[]): Terminal[] {
  if (focusRouteIds.length === 0) return terminals;
  const focus = new Set(focusRouteIds);
  const result: Terminal[] = [];
  for (const terminal of terminals) {
    const routeIds = (terminal.routeIds ?? []).filter((routeId) => focus.has(routeId));
    if (routeIds.length === 0) continue;
    result.push({ ...terminal, routeIds });
  }
  return result;
}

// Infer terminal candidates from the endpoints of active route/direction schedules.
export function autoDiscoverTerminals(db: Database, activeServiceIds: Set<string>): Terminal[] {
  const serviceList = Array.from(activeServiceIds);
  if (serviceList.length === 0) return [];
  // Bounding each trip once (instead of returning every stop_time) keeps discovery fast on a
  // full agency feed: only the first and last stop of each active trip are needed.
  const rows = db
    .prepare(
      `
      SELECT t.route_id, t.direction_id, e.trip_id, f.stop_id AS first_stop, l.stop_id AS last_stop
      FROM (
        SELECT trip_id, MIN(stop_sequence) AS min_seq, MAX(stop_sequence) AS max_seq
        FROM stop_times GROUP BY trip_id
      ) e
      JOIN trips t ON t.trip_id = e.trip_id AND t.service_id IN (${placeholders(serviceList.length)})
      JOIN stop_times f ON f.trip_id = e.trip_id AND f.stop_sequence = e.min_seq
      JOIN stop_times l ON l.trip_id = e.trip_id AND l.stop_sequence = e.max_seq
      `,
    )
    .all(...serviceList) as Array<{
    route_id: string;
    direction_id: number | null;
    trip_id: string;
    first_stop: string;
    last_stop: string;
  }>;

  // Count trips per route/direction endpoint. First and last are counted separately so a
  // single-stop trip cannot satisfy the threshold twice on its own.
  const countEndpoint = (target: Map<string, Map<string, number>>, key: string, stopId: string) => {
    let byStop = target.get(key);
    if (!byStop) {
      byStop = new Map();
      target.set(key, byStop);
    }
    byStop.set(stopId, (byStop.get(stopId) ?? 0) + 1);
  };
  const firstCounts = new Map<string, Map<string, number>>();
  const lastCounts = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const dir = row.direction_id === null ? '' : String(row.direction_id);
    const key = `${row.route_id}:${dir}`;
    countEndpoint(firstCounts, key, row.first_stop);
    countEndpoint(lastCounts, key, row.last_stop);
  }

  function endpointsAtLeast(counts: Map<string, Map<string, number>>): Map<string, Set<string>> {
    // Keep every distinct endpoint served by enough trips, not just the modal one, so a minority
    // time-of-day terminal variant survives discovery. Below-threshold endpoints are deadheads.
    const result = new Map<string, Set<string>>();
    for (const [key, byStop] of counts) {
      const kept = new Set<string>();
      for (const [stopId, count] of byStop) {
        if (count >= DISCOVERY_MIN_TRIPS) kept.add(stopId);
      }
      if (kept.size > 0) result.set(key, kept);
    }
    return result;
  }

  // Stop names/coordinates are a small table; load them once rather than joining every stop_time.
  const stopMeta = new Map<string, { name: string; lat: number; lon: number }>();
  for (const row of db.prepare('SELECT stop_id, stop_name, lat, lon FROM stops').all() as Array<{
    stop_id: string;
    stop_name: string;
    lat: number;
    lon: number;
  }>) {
    stopMeta.set(row.stop_id, { name: row.stop_name, lat: row.lat, lon: row.lon });
  }

  const firstEndpoints = endpointsAtLeast(firstCounts);
  const lastEndpoints = endpointsAtLeast(lastCounts);

  const stopsByRoute = new Map<string, Set<string>>();
  const addEndpoint = (key: string, stopId: string) => {
    const routeId = key.slice(0, key.lastIndexOf(':'));
    if (routeId === '') return;
    let stops = stopsByRoute.get(routeId);
    if (!stops) {
      stops = new Set();
      stopsByRoute.set(routeId, stops);
    }
    stops.add(stopId);
  };
  for (const [key, stopIds] of firstEndpoints) {
    for (const stopId of stopIds) addEndpoint(key, stopId);
  }
  for (const [key, stopIds] of lastEndpoints) {
    for (const stopId of stopIds) addEndpoint(key, stopId);
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
