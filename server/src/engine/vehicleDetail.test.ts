import { describe, expect, it } from 'vitest';
import { createDatabase } from '../db/schema';
import { loadStatic } from '../db/staticLoader';
import { Engine } from './engine';
import { InterventionStore } from '../db/interventions';
import { syntheticGtfs, type RouteSpec, type StopSpec, type TripSpec } from '../test/fixtures';
import type { RealtimeSnapshot } from '../providers/types';
import type { AppConfig, TripUpdateInfo, VehiclePositionInfo } from '../../../shared/types';

// Vehicle card and block strip are read-only projections over a cached snapshot + the retained
// feed (and, for the strip, the run ledger). These tests drive the engine to produce the card
// presence the endpoints depend on, then assert on the wrapper output.

const DETAIL_START = 8 * 3600;
const STRIP_START = 7 * 3600;

function svc(start: number, hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 3600 + m! * 60 - start;
}

function nowAt(hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  // UTC instants + the UTC agency timezone keep the fixture wall clock equal to the schedule
  // clock regardless of the host's local timezone (the suite also runs under TZ=America/New_York).
  return new Date(Date.UTC(2026, 7, 13, h!, m!, 0));
}

function unixAt(hhmm: string): number {
  return Math.floor(nowAt(hhmm).getTime() / 1000);
}

function vpAtStop(
  vehicleId: string,
  tripId: string,
  stopId: string,
  hhmm: string,
  currentStopSequence?: number,
): VehiclePositionInfo {
  return {
    vehicleId,
    tripId,
    stopId,
    currentStopSequence,
    lat: stopCoord(stopId).lat,
    lon: stopCoord(stopId).lon,
    timestamp: unixAt(hhmm),
  };
}

function tu(
  tripId: string,
  vehicleId: string,
  stopTimeUpdates: TripUpdateInfo['stopTimeUpdates'],
): TripUpdateInfo {
  return { tripId, vehicleId, stopTimeUpdates, timestamp: 1700000000 };
}

const stopCoord = (stopId: string): { lat: number; lon: number } => {
  if (stopId === 'T') return { lat: 41.8, lon: -87.6 };
  if (stopId === 'A2') return { lat: 41.79, lon: -87.62 };
  if (stopId === 'A3') return { lat: 41.78, lon: -87.63 };
  if (stopId === 'A4') return { lat: 41.77, lon: -87.64 };
  if (stopId === 'A5') return { lat: 41.76, lon: -87.65 };
  if (stopId === 'A6') return { lat: 41.75, lon: -87.66 };
  if (stopId === 'A7') return { lat: 41.74, lon: -87.67 };
  if (stopId === 'A8') return { lat: 41.73, lon: -87.68 };
  if (stopId === 'A9') return { lat: 41.72, lon: -87.69 };
  return { lat: 41.7, lon: -87.7 };
};

const detailStops: StopSpec[] = [
  { stopId: 'T', name: 'Terminal', lat: 41.8, lon: -87.6 },
  { stopId: 'A2', name: 'Avenue 2', lat: 41.79, lon: -87.62 },
  { stopId: 'A3', name: 'Avenue 3', lat: 41.78, lon: -87.63 },
  { stopId: 'A4', name: 'Avenue 4', lat: 41.77, lon: -87.64 },
  { stopId: 'A5', name: 'Avenue 5', lat: 41.76, lon: -87.65 },
  { stopId: 'A6', name: 'Avenue 6', lat: 41.75, lon: -87.66 },
  { stopId: 'A7', name: 'Avenue 7', lat: 41.74, lon: -87.67 },
  { stopId: 'A8', name: 'Avenue 8', lat: 41.73, lon: -87.68 },
  { stopId: 'A9', name: 'Avenue 9', lat: 41.72, lon: -87.69 },
  { stopId: 'B', name: 'Far Stop', lat: 41.7, lon: -87.7 },
];

const routes: RouteSpec[] = [
  { routeId: '1', shortName: '10', color: 'FFB81C', textColor: '000000' },
];

// A single inbound->outbound pair where the outbound run has ten stops (enough to prove the
// 8-stop cap) and carries block/route identity for the detail card.
function detailFixture(): TripSpec[] {
  return [
    {
      tripId: 'P1',
      blockId: 'B1',
      routeId: '1',
      directionId: 0,
      stopTimes: [
        { stopId: 'B', arr: '08:00:00', dep: '08:00:00', pickup: 0 },
        { stopId: 'T', arr: '08:05:00', dep: '08:05:00', dropOff: 0 },
      ],
    },
    {
      tripId: 'D1',
      blockId: 'B1',
      routeId: '1',
      directionId: 1,
      stopTimes: [
        { stopId: 'T', arr: '08:10:00', dep: '08:10:00', pickup: 0 },
        { stopId: 'A2', arr: '08:15:00', dep: '08:15:00' },
        { stopId: 'A3', arr: '08:20:00', dep: '08:20:00' },
        { stopId: 'A4', arr: '08:25:00', dep: '08:25:00' },
        { stopId: 'A5', arr: '08:30:00', dep: '08:30:00' },
        { stopId: 'A6', arr: '08:35:00', dep: '08:35:00' },
        { stopId: 'A7', arr: '08:40:00', dep: '08:40:00' },
        { stopId: 'A8', arr: '08:45:00', dep: '08:45:00' },
        { stopId: 'A9', arr: '08:50:00', dep: '08:50:00' },
        { stopId: 'B', arr: '08:55:00', dep: '08:55:00', dropOff: 0 },
      ],
    },
  ];
}

interface Harness {
  engine: Engine;
  db: ReturnType<typeof createDatabase>;
  store: InterventionStore;
  config: AppConfig;
}

function makeEngine(trips: TripSpec[], extra: { routes?: RouteSpec[]; stops?: StopSpec[] } = {}): Harness {
  const gtfs = syntheticGtfs({ trips, routes: extra.routes ?? routes, stops: extra.stops ?? detailStops });
  const db = createDatabase(':memory:');
  loadStatic(db, gtfs);
  const config: AppConfig = {
    realtime: { tripUpdatesUrl: 'http://localhost/tu.pb' },
    staticGtfsUrl: 'http://localhost/gtfs.zip',
    agencyTimezone: 'UTC',
    refreshIntervalSeconds: 10,
    staticRefreshHours: 24,
    minRestMinutes: 5,
    maxHoldMinutes: 10,
    leadTimeMinutes: 5,
    lookaheadMinutes: 90,
    terminals: [{ id: 'T', name: 'Terminal', stopIds: ['T'], routeIds: ['1'] }],
    arrivalRadiusMeters: 150,
    stationaryDisplacementMeters: 20,
    confirmPings: 1,
    departPings: 1,
    departureTriggerMeters: 75,
  };
  const store = new InterventionStore(db);
  const engine = new Engine(db, () => config, store);
  return { engine, db, store, config };
}

describe('vehicleDetail', () => {
  // Refresh the fixture so D1 appears as a layover card (V1 parked at the terminal on P1), then
  // project the card against the same realtime snapshot.
  function layoverDetail(
    harness: Harness,
    d1Tu: TripUpdateInfo,
    at = '08:12',
  ): { detail: NonNullable<ReturnType<Engine['vehicleDetail']>>; snapshot: import('../../../shared/types').TerminalSnapshot } {
    const rt: RealtimeSnapshot = {
      timestamp: unixAt(at),
      tripUpdates: [tu('P1', 'V1', []), d1Tu],
      vehiclePositions: [vpAtStop('V1', 'P1', 'T', '08:08')],
    };
    const [snapshot] = harness.engine.refresh(rt, nowAt(at));
    const detail = harness.engine.vehicleDetail('T', 'D1', snapshot!, rt, nowAt(at));
    expect(detail).toBeDefined();
    return { detail: detail!, snapshot: snapshot! };
  }

  it('predicted upcoming stops come from the TU arrival times over the carried window', () => {
    const harness = makeEngine(detailFixture());
    const { detail } = layoverDetail(
      harness,
      tu('D1', 'V1', [
        { stopId: 'A2', stopSequence: 1, arrivalTime: unixAt('08:16') },
        { stopId: 'A3', stopSequence: 2, arrivalTime: unixAt('08:21') },
        { stopId: 'A4', stopSequence: 3, arrivalTime: unixAt('08:26') },
      ]),
    );
    expect(detail.vehicleId).toBe('V1');
    expect(detail.status).toBe('layover');
    expect(detail.routeShortName).toBe('10');
    expect(detail.color).toBe('FFB81C');
    expect(detail.directionId).toBe(1);
    expect(detail.destination).toBe('Far Stop');
    const stops = detail.upcomingStops.map((s) => [s.stopId, s.predicted, s.source]);
    expect(stops).toEqual([
      ['A2', svc(DETAIL_START, '08:16'), 'predicted'],
      ['A3', svc(DETAIL_START, '08:21'), 'predicted'],
      ['A4', svc(DETAIL_START, '08:26'), 'predicted'],
    ]);
    expect(detail.passedCount).toBe(1);
    expect(detail.passedStops).toHaveLength(1);
    expect(detail.passedStops![0]!.stopId).toBe('T');
    expect(detail.terminalStop?.stopId).toBe('T');
    // The live marker is present because the feed carries coordinates for the vehicle.
    expect(detail.position).toBeDefined();
    expect(detail.position!.lat).toBe(41.8);
    expect(detail.position!.observedAt).toBe(unixAt('08:08'));
    // Upcoming stops keep their map coordinates for the mini map dots.
    expect(detail.upcomingStops[0]!.lat).toBe(41.79);
  });

  it('mixes predicted and scheduled sources, filling stops the window skipped', () => {
    const harness = makeEngine(detailFixture());
    const { detail } = layoverDetail(
      harness,
      tu('D1', 'V1', [
        { stopId: 'A2', stopSequence: 1, arrivalTime: unixAt('08:16') },
        // A3 is absent from the window entirely; A4 is present but carries no timing.
        { stopId: 'A4', stopSequence: 3 },
      ]),
    );
    const stops = detail.upcomingStops.map((s) => [s.stopId, s.predicted, s.source]);
    expect(stops).toEqual([
      ['A2', svc(DETAIL_START, '08:16'), 'predicted'],
      ['A3', undefined, 'scheduled'],
      ['A4', undefined, 'scheduled'],
    ]);
  });

  it('excludes the current stop from the carried window even when the feed includes it', () => {
    const harness = makeEngine(detailFixture());
    // Park V1 on P1 (records D1's arrival), then move it onto the outbound leg at A2 while the
    // TU window still lists A2 (the current stop) as its first entry.
    const parked: RealtimeSnapshot = {
      timestamp: unixAt('08:08'),
      tripUpdates: [tu('P1', 'V1', [])],
      vehiclePositions: [vpAtStop('V1', 'P1', 'T', '08:08')],
    };
    harness.engine.refresh(parked, nowAt('08:08'));
    const window: RealtimeSnapshot = {
      timestamp: unixAt('08:12'),
      tripUpdates: [
        tu('P1', 'V1', []),
        tu('D1', 'V1', [
          { stopId: 'A2', stopSequence: 1, arrivalTime: unixAt('08:16') },
          { stopId: 'A3', stopSequence: 2, arrivalTime: unixAt('08:21') },
          { stopId: 'A4', stopSequence: 3, arrivalTime: unixAt('08:26') },
        ]),
      ],
      vehiclePositions: [vpAtStop('V1', 'D1', 'A2', '08:12', 1)],
    };
    const [snapshot] = harness.engine.refresh(window, nowAt('08:12'));
    const detail = harness.engine.vehicleDetail('T', 'D1', snapshot!, window, nowAt('08:12'))!;
    // A2 is where the bus is standing; the card shows only what lies ahead.
    expect(detail.upcomingStops.map((s) => s.stopId)).toEqual(['A3', 'A4']);
    expect(detail.passedCount).toBe(2);
    expect(detail.passedStops!.map((s) => s.stopId)).toEqual(['T', 'A2']);
  });

  it('falls back to schedule-clock windowing when the trip has no TU entity', () => {
    const harness = makeEngine(detailFixture());
    // No D1 TU at all: the first stop whose departure is at/after now-120s wins.
    const { detail } = layoverDetail(harness, tu('NO_SUCH_TRIP', 'V1', []), '08:12');
    expect(detail.upcomingStops.every((s) => s.source === 'scheduled' && s.predicted === undefined)).toBe(true);
    // nowSvc 08:12 -> grace 08:10 -> terminal stop T (departure 08:10) is the first entry.
    expect(detail.upcomingStops[0]!.stopId).toBe('T');
    expect(detail.passedCount).toBe(0);
    expect(detail.upcomingStops.map((s) => s.stopId)).toEqual(['T', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8']);
  });

  it('caps the window at 8 stops and derives passedCount from the first carried entry', () => {
    const harness = makeEngine(detailFixture());
    const window = Array.from({ length: 9 }, (_, i) => ({
      stopId: i === 8 ? 'B' : `A${i + 2}`,
      stopSequence: i + 1,
      arrivalTime: unixAt(`08:${String(16 + i).padStart(2, '0')}`),
    }));
    const { detail } = layoverDetail(harness, tu('D1', 'V1', window));
    expect(detail.upcomingStops).toHaveLength(8);
    expect(detail.upcomingStops[0]!.stopId).toBe('A2');
    expect(detail.upcomingStops[7]!.stopId).toBe('A9');
    expect(detail.passedCount).toBe(1);
  });

  it('uses the arrival delay for a carried stop without an absolute time', () => {
    const harness = makeEngine(detailFixture());
    const { detail } = layoverDetail(
      harness,
      tu('D1', 'V1', [
        { stopId: 'A2', stopSequence: 1, arrivalDelay: 300 },
        { stopId: 'A3', stopSequence: 2, arrivalDelay: 0 },
      ]),
    );
    const a2 = detail.upcomingStops.find((s) => s.stopId === 'A2')!;
    const a3 = detail.upcomingStops.find((s) => s.stopId === 'A3')!;
    expect(a2.source).toBe('predicted');
    expect(a2.predicted).toBe(svc(DETAIL_START, '08:15') + 300);
    // A zero delay is still a realtime prediction, not a schedule fallback.
    expect(a3.source).toBe('predicted');
    expect(a3.predicted).toBe(svc(DETAIL_START, '08:20'));
  });

  it('404s a trip unknown to static and a trip with no presence at the terminal', () => {
    const harness = makeEngine(detailFixture());
    const rt: RealtimeSnapshot = { timestamp: unixAt('08:12'), tripUpdates: [], vehiclePositions: [] };
    const [snapshot] = harness.engine.refresh(rt, nowAt('08:12'));
    expect(harness.engine.vehicleDetail('T', 'NOT_A_TRIP', snapshot!, rt, nowAt('08:12'))).toBeUndefined();
    expect(harness.engine.vehicleDetail('T', 'D1', snapshot!, rt, nowAt('08:12'))).toBeUndefined();
    expect(harness.engine.vehicleDetail('NOPE', 'D1', snapshot!, rt, nowAt('08:12'))).toBeUndefined();
  });

  it('renders without a map position when the retained feed no longer assigns the vehicle', () => {
    const harness = makeEngine(detailFixture());
    // Build a layover card with a full feed, then project the SAME cached snapshot against an
    // empty retained feed: presence survives from the cached card, but vehicle + map data do not.
    const rt: RealtimeSnapshot = {
      timestamp: unixAt('08:08'),
      tripUpdates: [tu('P1', 'V1', []), tu('D1', 'V1', [])],
      vehiclePositions: [vpAtStop('V1', 'P1', 'T', '08:08')],
    };
    const [snapshot] = harness.engine.refresh(rt, nowAt('08:12'));
    const emptyRt: RealtimeSnapshot = { timestamp: unixAt('08:13'), tripUpdates: [], vehiclePositions: [] };
    const detail = harness.engine.vehicleDetail('T', 'D1', snapshot!, emptyRt, nowAt('08:12'))!;
    expect(detail.status).toBe('layover');
    expect(detail.vehicleId).toBeUndefined();
    expect(detail.position).toBeUndefined();
    // Schedule-clock fallback still supplies the stops.
    expect(detail.upcomingStops.length).toBeGreaterThan(0);
    expect(detail.upcomingStops.every((s) => s.source === 'scheduled')).toBe(true);
  });
});

describe('blockTimeline', () => {
  function stripFixture(): TripSpec[] {
    return [
      {
        tripId: 'L1',
        blockId: 'BLK',
        routeId: '1',
        directionId: 0,
        stopTimes: [
          { stopId: 'B', arr: '07:00:00', dep: '07:00:00', pickup: 0 },
          { stopId: 'T', arr: '07:30:00', dep: '07:30:00', dropOff: 0 },
        ],
      },
      {
        tripId: 'D1',
        blockId: 'BLK',
        routeId: '1',
        directionId: 1,
        stopTimes: [
          { stopId: 'T', arr: '07:45:00', dep: '07:45:00', pickup: 0 },
          { stopId: 'B', arr: '08:30:00', dep: '08:30:00', dropOff: 0 },
        ],
      },
      {
        tripId: 'D2',
        blockId: 'BLK',
        routeId: '2',
        directionId: 1,
        stopTimes: [
          { stopId: 'T', arr: '08:45:00', dep: '08:45:00', pickup: 0 },
          { stopId: 'C', arr: '09:30:00', dep: '09:30:00', dropOff: 0 },
        ],
      },
    ];
  }

  function stripHarness(): Harness {
    return makeEngine(stripFixture(), {
      routes: [routes[0]!, { routeId: '2', shortName: '20', color: 'FFB81C' }],
      stops: [
        ...detailStops.filter((s) => s.stopId === 'T' || s.stopId === 'B'),
        { stopId: 'C', name: 'Loop', lat: 41.75, lon: -87.65 },
      ],
    });
  }

  it('orders trips by block seq and assigns past/current/future windows at now', () => {
    const harness = stripHarness();
    const timeline = harness.engine.blockTimeline('BLK', nowAt('08:10'))!;
    expect(timeline.blockId).toBe('BLK');
    expect(timeline.serviceDate).toBe('20260813');
    expect(timeline.nowSvc).toBe(svc(STRIP_START, '08:10'));
    expect(timeline.trips.map((t) => [t.tripId, t.state, t.destination])).toEqual([
      ['L1', 'past', 'Terminal'],
      ['D1', 'current', 'Far Stop'],
      ['D2', 'future', 'Loop'],
    ]);
    const d1 = timeline.trips[1]!;
    expect(d1.start).toBe(svc(STRIP_START, '07:45'));
    expect(d1.end).toBe(svc(STRIP_START, '08:30'));
    expect(d1.routeShortName).toBe('10');
    expect(d1.color).toBe('FFB81C');
    expect(d1.directionId).toBe(1);
  });

  it('propagates an observed departure fact and applied hold onto the current trip', () => {
    const harness = stripHarness();
    const serviceDate = '20260813';
    const now = unixAt('08:10');
    const suggestion = harness.store.createSuggestion({
      id: 'hold:20260813:T:1:D1',
      serviceDate,
      terminalId: 'T',
      routeId: '1',
      rule: 'hold',
      tripId: 'D1',
      vehicleId: 'V1',
      holdSeconds: 90,
      reason: 'test',
      until: svc(STRIP_START, '08:14'),
      generatedAt: now,
      expiresAt: now + 3600,
    });
    harness.store.apply(suggestion.id, { actorId: 'test' }, now);

    // Park V1 on L1 (arrival for D1), then pull out on D1 to record its departure.
    const parked: RealtimeSnapshot = {
      timestamp: unixAt('07:40'),
      tripUpdates: [tu('L1', 'V1', []), tu('D1', 'V1', [])],
      vehiclePositions: [vpAtStop('V1', 'L1', 'T', '07:40')],
    };
    harness.engine.refresh(parked, nowAt('07:40'));
    const departed: RealtimeSnapshot = {
      timestamp: unixAt('08:10'),
      tripUpdates: [tu('L1', 'V1', []), tu('D1', 'V1', [])],
      vehiclePositions: [vpAtStop('V1', 'D1', 'B', '08:10')],
    };
    harness.engine.refresh(departed, nowAt('08:10'));

    const timeline = harness.engine.blockTimeline('BLK', nowAt('08:10'))!;
    const d1 = timeline.trips.find((t) => t.tripId === 'D1')!;
    // The bus departed D1 under the locked hold; the departure fact + held flag both surface.
    expect(d1.state).toBe('current');
    expect(d1.departedSeconds).toBeDefined();
    expect(d1.held).toBe(true);
    // A never-held past inbound leg is unflagged and has no terminal departure fact; only the
    // outbound run's departure (recorded for D1 at the terminal) surfaces.
    const l1 = timeline.trips.find((t) => t.tripId === 'L1')!;
    expect(l1.held).toBe(false);
    expect(l1.departedSeconds).toBeUndefined();
  });

  it('404s an unknown block', () => {
    const harness = stripHarness();
    expect(harness.engine.blockTimeline('NO_BLOCK', nowAt('08:10'))).toBeUndefined();
  });
});