import { transit_realtime } from 'gtfs-realtime-bindings';
import type { StopTimePrediction, TripUpdateInfo, VehiclePositionInfo } from '../../../shared/types';

const FeedMessage = transit_realtime.FeedMessage;

// protobuf numeric fields can be plain numbers or Long-like objects depending on the decoder/runtime.
function toSeconds(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return value;
  if (typeof (value as { toNumber?: unknown }).toNumber === 'function') {
    return (value as { toNumber: () => number }).toNumber();
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function toAbsTime(value: unknown): number | undefined {
  // GTFS-RT uses zero/absent timestamps as "not supplied" for this normalization boundary.
  const seconds = toSeconds(value);
  return seconds !== undefined && seconds > 0 ? seconds : undefined;
}

// Fetch a protobuf feed with a bounded request lifetime.
export async function fetchFeed(url: string, timeoutMs = 15000): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Abort protects the refresh loop from a provider that never completes.
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`GTFS-RT feed failed: ${url} -> ${res.status} ${res.statusText}`);
    }
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

// Decode TripUpdate entities and expose only fields required by the engine.
export function decodeTripUpdates(buffer: Buffer, fallbackTimestamp: number): TripUpdateInfo[] {
  const feed = FeedMessage.decode(new Uint8Array(buffer));
  const timestamp = toSeconds(feed.header?.timestamp) ?? fallbackTimestamp;
  const updates: TripUpdateInfo[] = [];
  for (const entity of feed.entity ?? []) {
    const tu = entity.tripUpdate;
    if (!tu) continue;
    const tripId = tu.trip?.tripId;
    if (!tripId) continue;
    // Discard incomplete entities here so engine code can rely on a usable trip identifier.
    const stopTimeUpdates: StopTimePrediction[] = [];
    for (const stu of tu.stopTimeUpdate ?? []) {
      if (!stu.stopId && stu.stopSequence === undefined) continue;
      stopTimeUpdates.push({
        stopId: stu.stopId ?? '',
        stopSequence: stu.stopSequence ?? 0,
        arrivalDelay: toSeconds(stu.arrival?.delay),
        departureDelay: toSeconds(stu.departure?.delay),
        arrivalTime: toAbsTime(stu.arrival?.time),
        departureTime: toAbsTime(stu.departure?.time),
      });
    }
    updates.push({
      tripId,
      vehicleId: tu.vehicle?.id ?? undefined,
      routeId: tu.trip?.routeId ?? undefined,
      delay: toSeconds(tu.delay),
      stopTimeUpdates,
      timestamp: toSeconds(tu.timestamp) ?? timestamp,
    });
  }
  return updates;
}

// Decode VehiclePosition entities and retain the identifiers used for VP fact recording.
export function decodeVehiclePositions(buffer: Buffer, fallbackTimestamp: number): VehiclePositionInfo[] {
  const feed = FeedMessage.decode(new Uint8Array(buffer));
  const timestamp = toSeconds(feed.header?.timestamp) ?? fallbackTimestamp;
  const positions: VehiclePositionInfo[] = [];
  for (const entity of feed.entity ?? []) {
    const vp = entity.vehicle;
    if (!vp) continue;
    const vehicleId = vp.vehicle?.id;
    if (!vehicleId) continue;
    // Vehicle ID is the stable key used to associate positions with block trips and run facts.
    const tripId = vp.trip?.tripId;
    const stopId = vp.stopId ?? undefined;
    const stopSequence = toSeconds(vp.currentStopSequence);
    positions.push({
      vehicleId,
      tripId: tripId || undefined,
      stopId: stopId || undefined,
      currentStopSequence: stopSequence !== undefined && stopSequence > 0 ? stopSequence : undefined,
      timestamp: toSeconds(vp.timestamp) ?? timestamp,
    });
  }
  return positions;
}
