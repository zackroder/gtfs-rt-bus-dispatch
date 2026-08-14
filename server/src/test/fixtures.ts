import type { ParsedStaticGtfs } from '../providers/types';
import { detectServiceDayStart, parseGtfsTime } from '../gtfs/time';

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
}

export interface StopSpec {
  stopId: string;
  name: string;
}

function rawSeconds(time: string): number {
  const parsed = parseGtfsTime(time);
  if (parsed === null) throw new Error(`bad time ${time}`);
  return parsed;
}

export function syntheticGtfs(opts: {
  routes?: RouteSpec[];
  stops?: StopSpec[];
  trips: TripSpec[];
}): ParsedStaticGtfs {
  const routes = (opts.routes ?? [{ routeId: '1', shortName: '1' }]).map((r) => ({
    routeId: r.routeId,
    agencyId: 'TEST',
    shortName: r.shortName,
    longName: r.shortName,
    type: r.type ?? 3,
  }));
  const stops = (opts.stops ?? [
    { stopId: 'T', name: 'Terminal' },
    { stopId: 'B', name: 'Far Stop' },
  ]).map((s) => ({
    stopId: s.stopId,
    stopCode: s.stopId,
    stopName: s.name,
    parentStation: undefined,
    lat: 41.8,
    lon: -87.6,
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
