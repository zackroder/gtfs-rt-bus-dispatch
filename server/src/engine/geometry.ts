import type { Database } from 'better-sqlite3';

// Geometry helpers keep proximity semantics in one place so the engine's transition
// logic reads as rules rather than raw distance math.

export interface GeoPoint {
  lat: number;
  lon: number;
}

// Equirectangular approximation is accurate enough at terminal scale (hundreds of
// meters) and avoids the trig cost of spherical distance on every VP observation.
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const x = dLon * Math.cos((lat1 + lat2) / 2);
  const y = dLat;
  return Math.sqrt(x * x + y * y) * 6371000;
}

export interface NearestStop {
  stopId?: string;
  meters: number;
}

// Initial bearing (degrees clockwise from north) from one point to another, used to orient
// map arrows along the implied direction of travel. The equirectangular simplification is
// consistent with distanceMeters at terminal scale.
export function bearingDegrees(from: GeoPoint, to: GeoPoint): number {
  const lat1 = (from.lat * Math.PI) / 180;
  const lat2 = (to.lat * Math.PI) / 180;
  const dLon = ((to.lon - from.lon) * Math.PI) / 180;
  const x = Math.sin(dLon) * Math.cos(lat2);
  const y = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}

// Distance from a point to the closest of a set of stop IDs, treating missing
// stop coordinates as absent so a misconfigured terminal cannot arbitrate facts.
export function nearestStopMeters(
  coords: ReadonlyMap<string, GeoPoint>,
  stopIds: readonly string[],
  point: GeoPoint | undefined,
): NearestStop {
  if (!point) return { meters: Infinity };
  let best: NearestStop = { meters: Infinity };
  for (const stopId of stopIds) {
    const coord = coords.get(stopId);
    if (!coord) continue;
    const meters = distanceMeters(point, coord);
    if (meters < best.meters) best = { stopId, meters };
  }
  return best;
}

// Distance to a single stop (used for the "last stop of current trip" arrival anchor).
export function distanceToStopMeters(
  coords: ReadonlyMap<string, GeoPoint>,
  stopId: string | undefined,
  point: GeoPoint | undefined,
): number {
  if (!point || !stopId) return Infinity;
  const coord = coords.get(stopId);
  return coord ? distanceMeters(point, coord) : Infinity;
}

// Load stop coordinates once per static snapshot; callers invalidate on reload.
export function stopCoordinates(db: Database): Map<string, GeoPoint> {
  const rows = db.prepare('SELECT stop_id, lat, lon FROM stops').all() as Array<{
    stop_id: string;
    lat: number;
    lon: number;
  }>;
  const map = new Map<string, GeoPoint>();
  for (const row of rows) {
    if (Number.isFinite(row.lat) && Number.isFinite(row.lon)) map.set(row.stop_id, { lat: row.lat, lon: row.lon });
  }
  return map;
}