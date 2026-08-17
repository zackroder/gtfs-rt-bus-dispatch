import type { ParsedStaticGtfs } from '../providers/types';
import { detectServiceDayStart, parseGtfsTime } from '../gtfs/time';

// These small specifications make engine tests readable while still exercising the same
// normalized GTFS shapes used by the production static loader.
export interface StopTimeSpec {
  stopId: string;
  arr: string;
  dep: string;
  pickup?: number;
  dropOff?: number;
}

export interface TripSpec {
  tripId: string;
  routeId?: string;
  blockId?: string;
  stopTimes: StopTimeSpec[];
}

export interface RouteSpec {
  routeId: string;
  shortName: string;
  type?: number;
  color?: string;
  textColor?: string;
}

export interface StopSpec {
  stopId: string;
  name: string;
  lat?: number;
  lon?: number;
}

function rawSeconds(time: string): number {
  const parsed = parseGtfsTime(time);
  if (parsed === null) throw new Error(`bad time ${time}`);
  return parsed;
}

// Build a deterministic in-memory GTFS fixture with an active calendar and detected clock origin.
export function syntheticGtfs(opts: {
  routes?: RouteSpec[];
  stops?: StopSpec[];
  trips: TripSpec[];
}): ParsedStaticGtfs {
  // Fixtures use an always-active service and bus routes so tests focus on dispatch behavior,
  // not on downloading or filtering a real agency feed.
  const routes = (opts.routes ?? [{ routeId: '1', shortName: '1' }]).map((r) => ({
    routeId: r.routeId,
    agencyId: 'TEST',
    shortName: r.shortName,
    longName: r.shortName,
    type: r.type ?? 3,
    color: r.color,
    textColor: r.textColor,
  }));
  // Stop coordinates default to separated locations so proximity logic can distinguish the
  // terminal (T) from the far endpoint (B) without explicit per-test fixtures.
  const stops = (opts.stops ?? [
    { stopId: 'T', name: 'Terminal', lat: 41.8, lon: -87.6 },
    { stopId: 'B', name: 'Far Stop', lat: 41.7, lon: -87.7 },
  ]).map((s) => ({
    stopId: s.stopId,
    stopCode: s.stopId,
    stopName: s.name,
    parentStation: undefined,
    lat: s.lat ?? 41.8,
    lon: s.lon ?? -87.6,
  }));
  const trips = opts.trips.map((t) => ({
    tripId: t.tripId,
    routeId: t.routeId ?? '1',
    serviceId: 'SVC1',
    blockId: t.blockId ?? undefined,
    directionId: undefined,
    headsign: 'Test',
  }));
  const stopTimes = opts.trips.flatMap((t) =>
    t.stopTimes.map((st, i) => ({
      tripId: t.tripId,
      stopSequence: i,
      stopId: st.stopId,
      arrivalTime: rawSeconds(st.arr),
      departureTime: rawSeconds(st.dep),
      pickupType: st.pickup,
      dropOffType: st.dropOff,
    })),
  );

  const spanByTrip = new Map<string, { start: number; end: number }>();
  for (const t of opts.trips) {
    const first = t.stopTimes[0]!;
    const last = t.stopTimes[t.stopTimes.length - 1]!;
    spanByTrip.set(t.tripId, {
      start: rawSeconds(first.dep),
      end: rawSeconds(last.arr),
    });
  }
  const serviceDayStartSeconds = detectServiceDayStart(
    Array.from(spanByTrip.values(), (span) => ({ startRaw: span.start, endRaw: span.end })),
  );

  return {
    stops,
    routes,
    trips,
    stopTimes,
    calendar: [
      {
        serviceId: 'SVC1',
        monday: 1,
        tuesday: 1,
        wednesday: 1,
        thursday: 1,
        friday: 1,
        saturday: 1,
        sunday: 1,
        startDate: '20200101',
        endDate: '20991231',
      },
    ],
    calendarDates: [],
    serviceDayStartSeconds,
  };
}
