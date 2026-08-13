import { transit_realtime } from 'gtfs-realtime-bindings';
import type { StopTimePrediction, TripUpdateInfo, VehiclePosition } from '../../../shared/types';

const FeedMessage = transit_realtime.FeedMessage;

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
  const seconds = toSeconds(value);
  return seconds !== undefined && seconds > 0 ? seconds : undefined;
}

export async function fetchFeed(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GTFS-RT feed failed: ${url} -> ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export function decodeVehiclePositions(buffer: Buffer, fallbackTimestamp: number): VehiclePosition[] {
  const feed = FeedMessage.decode(new Uint8Array(buffer));
  const timestamp = toSeconds(feed.header?.timestamp) ?? fallbackTimestamp;
  const vehicles: VehiclePosition[] = [];
  for (const entity of feed.entity ?? []) {
    const v = entity.vehicle;
    if (!v) continue;
    const vehicleId = v.vehicle?.id;
    const tripId = v.trip?.tripId ?? undefined;
    if (vehicleId === undefined && tripId === undefined) continue;
    const position = v.position;
    vehicles.push({
      vehicleId: vehicleId ?? entity.id,
      tripId,
      routeId: v.trip?.routeId ?? undefined,
      stopId: v.stopId ?? undefined,
      stopSequence: v.currentStopSequence ?? undefined,
      lat: position ? position.latitude : undefined,
      lon: position ? position.longitude : undefined,
      timestamp: toSeconds(v.timestamp) ?? timestamp,
    });
  }
  return vehicles;
}

export function decodeTripUpdates(buffer: Buffer, fallbackTimestamp: number): TripUpdateInfo[] {
  const feed = FeedMessage.decode(new Uint8Array(buffer));
  const timestamp = toSeconds(feed.header?.timestamp) ?? fallbackTimestamp;
  const updates: TripUpdateInfo[] = [];
  for (const entity of feed.entity ?? []) {
    const tu = entity.tripUpdate;
    if (!tu) continue;
    const tripId = tu.trip?.tripId;
    if (!tripId) continue;
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
