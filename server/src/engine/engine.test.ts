import { describe, expect, it } from 'vitest';
import { createDatabase } from '../db/schema';
import { loadStatic } from '../db/staticLoader';
import { Engine } from './engine';
import { InterventionStore } from '../db/interventions';
import { syntheticGtfs } from '../test/fixtures';
import type { TripSpec } from '../test/fixtures';
import type { RealtimeSnapshot } from '../providers/types';
import type { AppConfig, TripUpdateInfo, VehiclePositionInfo } from '../../../shared/types';

// This fixture models four block vehicles, their inbound legs, and staggered outbound departures.
// It is intentionally rich enough to exercise VP-only facts, EDT, holds, and service-day restore.
const START = 8 * 3600;

function svc(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 3600 + m! * 60 - START;
}

function nowAt(hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2026, 7, 13, h!, m!, 0);
}

function unixAt(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return Math.floor(new Date(2026, 7, 13, h!, m!, 0).getTime() / 1000);
}

function arrUpdate(tripId: string, vehicleId: string): TripUpdateInfo {
  return {
    tripId,
    vehicleId,
    stopTimeUpdates: [{ stopId: 'T', stopSequence: 99, arrivalDelay: 0 }],
    timestamp: 1700000000,
  };
}

function depUpdate(tripId: string, vehicleId: string, hhmm: string): TripUpdateInfo {
  return {
    tripId,
    vehicleId,
    stopTimeUpdates: [{ stopId: 'T', stopSequence: 0, departureTime: unixAt(hhmm) }],
    timestamp: 1700000000,
  };
}

function fixtureTrips(): TripSpec[] {
  return [
    {
      tripId: 'P1',
      blockId: 'A',
      stopTimes: [
        { stopId: 'B', arr: '08:00:00', dep: '08:00:00', pickup: 0 },
        { stopId: 'T', arr: '08:02:00', dep: '08:02:00', dropOff: 0 },
      ],
    },
    {
      tripId: 'D1',
      blockId: 'A',
      stopTimes: [
        { stopId: 'T', arr: '08:10:00', dep: '08:10:00', pickup: 0 },
        { stopId: 'B', arr: '08:40:00', dep: '08:40:00', dropOff: 0 },
      ],
    },
    {
      tripId: 'P2',
      blockId: 'B',
      stopTimes: [
        { stopId: 'B', arr: '08:00:00', dep: '08:00:00', pickup: 0 },
        { stopId: 'T', arr: '08:07:00', dep: '08:07:00', dropOff: 0 },
      ],
    },
    {
      tripId: 'D2',
      blockId: 'B',
      stopTimes: [
        { stopId: 'T', arr: '08:11:00', dep: '08:11:00', pickup: 0 },
        { stopId: 'B', arr: '08:41:00', dep: '08:41:00', dropOff: 0 },
      ],
    },
    {
      tripId: 'P3',
      blockId: 'C',
      stopTimes: [
        { stopId: 'B', arr: '08:00:00', dep: '08:00:00', pickup: 0 },
        { stopId: 'T', arr: '08:18:00', dep: '08:18:00', dropOff: 0 },
      ],
    },
    {
      tripId: 'D3',
      blockId: 'C',
      stopTimes: [
        { stopId: 'T', arr: '08:20:00', dep: '08:20:00', pickup: 0 },
        { stopId: 'B', arr: '08:50:00', dep: '08:50:00', dropOff: 0 },
      ],
    },
    {
      tripId: 'P4',
      blockId: 'D',
      stopTimes: [
        { stopId: 'B', arr: '08:00:00', dep: '08:00:00', pickup: 0 },
        { stopId: 'T', arr: '08:25:00', dep: '08:25:00', dropOff: 0 },
      ],
    },
    {
      tripId: 'D4',
      blockId: 'D',
      stopTimes: [
        { stopId: 'T', arr: '08:30:00', dep: '08:30:00', pickup: 0 },
        { stopId: 'B', arr: '09:00:00', dep: '09:00:00', dropOff: 0 },
      ],
    },
    // First trip of its block (no block_id predecessor): hatches out of a non-rev/deadhead leg.
    {
      tripId: 'D5',
      stopTimes: [
        { stopId: 'T', arr: '08:35:00', dep: '08:35:00', pickup: 0 },
        { stopId: 'B', arr: '09:05:00', dep: '09:05:00', dropOff: 0 },
      ],
    },
  ];
}

const engineData = new WeakMap<Engine, {
  store: InterventionStore;
  db: ReturnType<typeof createDatabase>;
  config: AppConfig;
}>();

function makeEngine(): Engine {
  const gtfs = syntheticGtfs({ trips: fixtureTrips() });
  const db = createDatabase(':memory:');
  loadStatic(db, gtfs);
  const cfg: AppConfig = {
    realtime: {
      tripUpdatesUrl: 'http://localhost/tu.pb',
    },
    staticGtfsUrl: 'http://localhost/gtfs.zip',
    refreshIntervalSeconds: 10,
    staticRefreshHours: 24,
    minRestMinutes: 5,
    maxHoldMinutes: 10,
    leadTimeMinutes: 5,
    lookaheadMinutes: 90,
    terminals: [{ id: 'T', name: 'Terminal', stopIds: ['T'], routeIds: ['1'] }],
    // Deterministic unit tests commit on a single parked ping; production keeps the two-ping
    // default and is covered by a dedicated arm test below.
    arrivalRadiusMeters: 150,
    stationaryDisplacementMeters: 20,
    confirmPings: 1,
    departPings: 1,
  };
  const interventions = new InterventionStore(db);
  const engine = new Engine(db, () => cfg, interventions);
  engineData.set(engine, { store: interventions, db, config: cfg });
  return engine;
}

function testData(engine: Engine) {
  return engineData.get(engine)!;
}

function stdRt(): RealtimeSnapshot {
  // The standard snapshot has one departed leader, one assigned layover, and two incoming buses.
  return {
    timestamp: unixAt('08:08'),
    tripUpdates: [
      depUpdate('D1', 'V1', '08:05'),
      arrUpdate('P1', 'V1'),
      arrUpdate('P2', 'V2'),
      arrUpdate('P3', 'V3'),
      arrUpdate('P4', 'V4'),
    ],
    vehiclePositions: [
      vpAtStop('V1', 'D1', 'B', '08:05', 1),
      vpAtStop('V2', 'P2', 'T', '08:07', 1),
      // The incoming buses are observed on their inbound legs via VP (as CTA carries tripId on
      // VP); TU alone no longer implies currentTrip, so these are required for incoming state.
      vpAtStop('V3', 'P3', 'MID', '08:20'),
      vpAtStop('V4', 'P4', 'MID', '08:27'),
    ],
  };
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
    // Position the vehicle at the fixture's stop coordinates so the geometric fact pass has
    // lat/lon to measure proximity against terminal stops.
    lat: stopCoord(stopId).lat,
    lon: stopCoord(stopId).lon,
    timestamp: unixAt(hhmm),
  };
}

// Fixture stops mirror the synthetic GTFS coordinates (T = terminal, B = far stop).
const stopCoord = (stopId: string): { lat: number; lon: number } => {
  if (stopId === 'T') return { lat: 41.8, lon: -87.6 };
  if (stopId === 'MID') return { lat: 41.75, lon: -87.65 };
  return { lat: 41.7, lon: -87.7 };
};

function route1(snapshot: ReturnType<Engine['refresh']>[number]) {
  return snapshot.routes.find((r) => r.routeId === '1')!;
}

describe('engine triplet dispatch', () => {
  // These tests verify orchestration and persistence around the pure dispatch rule.
  it('queues the center suggestion and applies it only after approval', () => {
    const engine = makeEngine();
    const rt = stdRt();

    const first = engine.refresh(rt, nowAt('08:08'))[0]!;
    const routeA = route1(first);
    expect(routeA.interventions).toHaveLength(1);
    const suggestion = routeA.interventions[0]!;
    expect(suggestion.rule).toBe('hold');
    expect(suggestion.status).toBe('pending');
    expect(suggestion.holdSeconds).toBe(120);
    expect(suggestion.until).toBe(svc('08:14'));
    expect(suggestion.vehicleId).toBe('V2');

    const d2 = routeA.layovers.find((l) => l.tripId === 'D2')!;
    expect(d2.hold).toBeUndefined();
    expect(d2.predictedDeparture).toBe(svc('08:12'));

    testData(engine).store.apply(suggestion.id, { actorId: 'test' }, unixAt('08:08'));
    const applied = route1(engine.refresh(rt, nowAt('08:08'))[0]!);
    expect(applied.interventions[0]!.status).toBe('applied');
    expect(applied.layovers.find((l) => l.tripId === 'D2')!.hold?.holdSeconds).toBe(120);

    const second = engine.refresh(rt, nowAt('08:18'))[0]!;
    const routeB = route1(second);
    expect(routeB.interventions[0]!.status).toBe('applied');
    const d2Later = routeB.layovers.find((l) => l.tripId === 'D2')!;
    expect(d2Later.hold?.holdSeconds).toBe(120);
    const d3 = routeB.layovers.find((l) => l.tripId === 'D3')!;
    expect(d3.hold).toBeUndefined();
    expect(d3.predictedDeparture).toBe(svc('08:23'));
  });

  it('uses the leader recorded departure rather than its EDT in the triplet', () => {
    const engine = makeEngine();
    const rt: RealtimeSnapshot = {
      timestamp: unixAt('08:08'),
      tripUpdates: [
        depUpdate('D1', 'V1', '08:07'),
        arrUpdate('P1', 'V1'),
        arrUpdate('P2', 'V2'),
        arrUpdate('P3', 'V3'),
        arrUpdate('P4', 'V4'),
      ],
      vehiclePositions: [
        vpAtStop('V1', 'D1', 'B', '08:07', 1),
        vpAtStop('V2', 'P2', 'T', '08:07', 1),
        vpAtStop('V3', 'P3', 'MID', '08:20'),
        vpAtStop('V4', 'P4', 'MID', '08:27'),
      ],
    };
    const snapshot = engine.refresh(rt, nowAt('08:08'))[0]!;
    const hold = route1(snapshot).interventions[0]!;
    expect(hold.holdSeconds).toBe(180);
    expect(hold.until).toBe(svc('08:15'));
  });

  it('does not fire before the trigger window opens from the EDT', () => {
    const engine = makeEngine();
    const snapshot = engine.refresh(stdRt(), nowAt('08:05'))[0]!;
    const route = route1(snapshot);
    expect(route.interventions).toEqual([]);
  });

  it('marks a rest-delayed layover with the EDT past the scheduled time', () => {
    const engine = makeEngine();
    const rt = stdRt();
    engine.refresh(rt, nowAt('08:08'));
    const snapshot = engine.refresh(rt, nowAt('08:18'))[0]!;
    const route = route1(snapshot);
    const d3 = route.layovers.find((l) => l.tripId === 'D3')!;
    expect(d3.terminalArrival).toBeUndefined();
    expect(d3.terminalArrivalSource).toBe('estimated');
    expect(d3.scheduledArrival).toBe(svc('08:18'));
    expect(d3.expectedDeparture).toBe(svc('08:23'));
    expect(d3.restDelayed).toBe(true);
    expect(d3.countdownSeconds).toBe(svc('08:23') - svc('08:18'));
  });

  it('keeps an on-time layover on its scheduled departure', () => {
    const engine = makeEngine();
    const rt = stdRt();
    engine.refresh(rt, nowAt('08:08'));
    engine.refresh(rt, nowAt('08:18'));
    const snapshot = engine.refresh(rt, nowAt('08:25'))[0]!;
    const route = route1(snapshot);
    const d4 = route.layovers.find((l) => l.tripId === 'D4')!;
    expect(d4.terminalArrival).toBeUndefined();
    expect(d4.terminalArrivalSource).toBe('estimated');
    expect(d4.scheduledArrival).toBe(svc('08:25'));
    expect(d4.expectedDeparture).toBe(svc('08:30'));
    expect(d4.restDelayed).toBe(false);
    expect(d4.predictedDeparture).toBe(svc('08:30'));
  });

  it('counts down to the effective held departure', () => {
    const engine = makeEngine();
    const snapshot = engine.refresh(stdRt(), nowAt('08:08'))[0]!;
    const route = route1(snapshot);
    const suggestion = route.interventions[0]!;
    testData(engine).store.apply(suggestion.id, { actorId: 'test' }, unixAt('08:08'));
    const applied = route1(engine.refresh(stdRt(), nowAt('08:08'))[0]!);
    const d2 = applied.layovers.find((l) => l.tripId === 'D2')!;
    expect(d2.countdownSeconds).toBe(svc('08:14') - svc('08:08'));
  });

  it('appends observed run events with terminal/route context and dispatch state', () => {
    const engine = makeEngine();
    const db = testData(engine).db;
    engine.refresh(stdRt(), nowAt('08:08'));
    engine.refresh(stdRt(), nowAt('08:09'));
    const rows = db
      .prepare(`SELECT event_type, trip_id, vehicle_id, terminal_id, route_id, source, value_seconds, classification, edt_seconds FROM run_events ORDER BY id`)
      .all() as Array<{
      event_type: string; trip_id: string; vehicle_id: string | null;
      terminal_id: string; route_id: string; source: string;
      value_seconds: number; classification: string; edt_seconds: number;
    }>;
    // D1 departed and D2 arrived (observed facts) in the fixture.
    const departure = rows.find((r) => r.event_type === 'departure' && r.trip_id === 'D1')!;
    expect(departure.vehicle_id).toBe('V1');
    expect(departure.terminal_id).toBe('T');
    expect(departure.route_id).toBe('1');
    expect(departure.value_seconds).toBe(svc('08:05'));
    const arrival = rows.find((r) => r.event_type === 'arrival' && r.trip_id === 'D2')!;
    expect(arrival.terminal_id).toBe('T');
    expect(arrival.classification).toBe('layover');
  });

  it('exposes incoming buses with predicted arrival and ETA', () => {
    const engine = makeEngine();
    const snapshot = engine.refresh(stdRt(), nowAt('08:08'))[0]!;
    const route = route1(snapshot);
    const d3 = route.incoming.find((i) => i.tripId === 'P3')!;
    expect(d3.predictedArrival).toBe(svc('08:18'));
    expect(d3.etaSeconds).toBe(svc('08:18') - svc('08:08'));
    expect(d3.delaySeconds).toBe(0);
    expect(d3.nextTripId).toBe('D3');
    expect(d3.nextDestination).toBe('Far Stop');
    expect(d3.scheduledDeparture).toBe(svc('08:20'));
    expect(d3.expectedDeparture).toBe(svc('08:23'));
    expect(d3.restDelayed).toBe(true);
  });

  it('uses the TripUpdate arrival.time at the inbound last stop as the estimated arrival', () => {
    const engine = makeEngine();
    // CTA TripUpdates carry arrival.time on the inbound trip's terminal stop; that absolute
    // value should drive the estimated inbound arrival rather than falling back to schedule.
    const rt: RealtimeSnapshot = {
      timestamp: unixAt('08:08'),
      tripUpdates: [
        {
          tripId: 'P2',
          vehicleId: 'V2',
          stopTimeUpdates: [
            { stopId: 'T', stopSequence: 1, arrivalTime: unixAt('08:09') },
          ],
          timestamp: 1700000000,
        },
      ],
      vehiclePositions: [vpAtStop('V2', 'P2', 'B', '08:08')],
    };
    const snapshot = engine.refresh(rt, nowAt('08:08'))[0]!;
    const route = route1(snapshot);
    const p2 = route.incoming.find((i) => i.tripId === 'P2')!;
    expect(p2.predictedArrival).toBe(svc('08:09'));
    expect(p2.delaySeconds).toBe(svc('08:09') - svc('08:07'));
    expect(p2.etaSeconds).toBe(svc('08:09') - svc('08:08'));
  });

  it('extends an intermediate stop prediction to the terminus by the scheduled offset', () => {
    const engine = makeEngine();
    // CTA omits the terminus (T) from the carried window but predicts an earlier stop (B), and the
    // vehicle is operating the inbound trip. The estimate must use B's realtime arrival advanced by
    // the scheduled B->T travel time (08:07 - 08:00 = 7 min).
    const rt: RealtimeSnapshot = {
      timestamp: unixAt('08:08'),
      tripUpdates: [
        {
          tripId: 'P2',
          vehicleId: 'V2',
          stopTimeUpdates: [
            { stopId: 'B', stopSequence: 0, arrivalTime: unixAt('08:08') },
          ],
          timestamp: 1700000000,
        },
      ],
      vehiclePositions: [vpAtStop('V2', 'P2', 'B', '08:08')],
    };
    const snapshot = engine.refresh(rt, nowAt('08:08'))[0]!;
    const p2 = route1(snapshot).incoming.find((i) => i.tripId === 'P2')!;
    // B realtime 08:08 + (sched T 08:07 - sched B 08:00) = 08:15
    expect(p2.predictedArrival).toBe(svc('08:15'));
    expect(p2.scheduledArrival).toBe(svc('08:07'));
    expect(p2.delaySeconds).toBe(svc('08:15') - svc('08:07'));
  });

  it('records departures globally so recently-departed survives unviewed gaps', () => {
    const engine = makeEngine();
    const rt = stdRt();
    engine.refresh(rt, nowAt('08:08'), new Set());
    const snapshot = engine.refresh(rt, nowAt('08:08'))[0]!;
    const route = route1(snapshot);
    const d1 = route.departed.find((d) => d.tripId === 'D1')!;
    expect(d1.departureSeconds).toBe(svc('08:05'));
  });

  it('restores observed run facts after an engine restart', () => {
    const first = makeEngine();
    first.refresh(stdRt(), nowAt('08:08'));
    const firstData = testData(first);
    const restarted = new Engine(firstData.db, () => firstData.config, firstData.store);
    const route = route1(restarted.refresh({ timestamp: unixAt('08:09'), tripUpdates: [], vehiclePositions: [] }, nowAt('08:09'))[0]!);
    expect(route.departed.some((bus) => bus.tripId === 'D1')).toBe(true);
    expect(route.layovers.some((bus) => bus.tripId === 'D2')).toBe(true);
  });

  it('lists recently departed buses with their recorded departure time', () => {
    const engine = makeEngine();
    const snapshot = engine.refresh(stdRt(), nowAt('08:08'))[0]!;
    const route = route1(snapshot);
    const d1 = route.departed.find((d) => d.tripId === 'D1')!;
    expect(d1.departureSeconds).toBe(svc('08:05'));
    expect(d1.vehicleId).toBe('V1');
    expect(d1.scheduledDeparture).toBe(svc('08:10'));
    expect(d1.headsign).toBe('Far Stop');
    expect(d1.held).toBe(false);
  });

  it('marks a departed bus as held when it left under a locked hold', () => {
    const engine = makeEngine();
    const rt = stdRt();
    engine.refresh(rt, nowAt('08:08'));
    const suggestion = route1(engine.refresh(rt, nowAt('08:08'))[0]!).interventions[0]!;
    testData(engine).store.apply(suggestion.id, { actorId: 'test' }, unixAt('08:08'));
    const later: RealtimeSnapshot = {
      timestamp: unixAt('08:20'),
      tripUpdates: [
        depUpdate('D1', 'V1', '08:05'),
        depUpdate('D2', 'V2', '08:16'),
        arrUpdate('P3', 'V3'),
        arrUpdate('P4', 'V4'),
      ],
      vehiclePositions: [vpAtStop('V2', 'D2', 'B', '08:16', 1)],
    };
    const snapshot = engine.refresh(later, nowAt('08:20'))[0]!;
    const d2 = route1(snapshot).departed.find((d) => d.tripId === 'D2')!;
    expect(d2.held).toBe(true);
    expect(d2.departureSeconds).toBe(svc('08:16'));
  });

  it('reports the vehicle current stop on a departed bus from VP', () => {
    const engine = makeEngine();
    const rt: RealtimeSnapshot = {
      timestamp: unixAt('08:20'),
      tripUpdates: [depUpdate('D1', 'V1', '08:05')],
      vehiclePositions: [vpAtStop('V1', 'D1', 'B', '08:20', 1)],
    };
    const snapshot = engine.refresh(rt, nowAt('08:20'))[0]!;
    const d1 = route1(snapshot).departed.find((d) => d.tripId === 'D1')!;
    expect(d1.currentStop).toBe('Far Stop');
  });

  it('exposes VP transition diagnostics alongside recorded fact events', () => {
    const engine = makeEngine();
    engine.refresh(stdRt(), nowAt('08:08'));
    const observations = engine.getVehiclePositionDiagnostics();
    const leader = observations.find((observation) => observation.vehicleId === 'V1')!;
    const layover = observations.find((observation) => observation.vehicleId === 'V2')!;
    // The geometric pass records a departure for the mid-route leader and an arrival for the
    // parked layover, exposing the buffer/stationarity signals that drove each transition.
    expect(leader.recordedDeparture).toBe(true);
    expect(leader.inTerminalBuffer).toBe(false);
    expect(leader.departureCandidateTripId).toBe('D1');
    expect(layover.recordedArrival).toBe(true);
    expect(layover.inTerminalBuffer).toBe(true);
    expect(layover.arrivalCandidateTripId).toBe('D2');
    expect(engine.getFactEventDiagnostics().map((event) => event.action)).toEqual(['departure', 'arrival']);
  });

  it('keeps a bus as layover when its terminal departure is still in the future', () => {
    const engine = makeEngine();
    const rt: RealtimeSnapshot = {
      timestamp: unixAt('08:08'),
      tripUpdates: [
        depUpdate('D1', 'V1', '08:05'),
        depUpdate('D2', 'V2', '08:14'),
        arrUpdate('P3', 'V3'),
        arrUpdate('P4', 'V4'),
      ],
      vehiclePositions: [vpAtStop('V2', 'D2', 'T', '08:08', 0)],
    };
    const snapshot = engine.refresh(rt, nowAt('08:08'))[0]!;
    const route = route1(snapshot);
    expect(route.departed.some((d) => d.tripId === 'D2')).toBe(false);
    expect(route.layovers.some((l) => l.tripId === 'D2')).toBe(true);
  });

  it('does not use a future TripUpdate departure prediction as EDT', () => {
    const engine = makeEngine();
    const rt: RealtimeSnapshot = {
      ...stdRt(),
      tripUpdates: [
        depUpdate('D1', 'V1', '08:05'),
        depUpdate('D2', 'V2', '08:40'),
        arrUpdate('P2', 'V2'),
        arrUpdate('P3', 'V3'),
        arrUpdate('P4', 'V4'),
      ],
    };
    const d2 = route1(engine.refresh(rt, nowAt('08:08'))[0]!).layovers.find((l) => l.tripId === 'D2')!;
    expect(d2.expectedDeparture).toBe(svc('08:12'));
  });

  it('keeps a bus incoming when the outbound TU is pre-assigned before arrival', () => {
    const engine = makeEngine();
    const rt: RealtimeSnapshot = {
      timestamp: unixAt('08:08'),
      tripUpdates: [depUpdate('D2', 'V2', '08:14')],
      vehiclePositions: [vpAtStop('V2', 'P2', 'MID', '08:08')],
    };
    const snapshot = engine.refresh(rt, nowAt('08:08'))[0]!;
    const route = route1(snapshot);
    expect(route.layovers.some((l) => l.tripId === 'D2')).toBe(false);
    const p2 = route.incoming.find((i) => i.tripId === 'P2')!;
    expect(p2.vehicleId).toBe('V2');
    expect(p2.nextTripId).toBe('D2');
  });

  it('drops a bus from layover once its terminal stop leaves the feed', () => {
    const engine = makeEngine();
    const rt: RealtimeSnapshot = {
      timestamp: unixAt('08:08'),
      tripUpdates: [
        depUpdate('D1', 'V1', '08:05'),
        {
          tripId: 'D2',
          vehicleId: 'V2',
          stopTimeUpdates: [{ stopId: 'B', stopSequence: 1, departureTime: unixAt('08:12') }],
          timestamp: 1700000000,
        },
        arrUpdate('P3', 'V3'),
        arrUpdate('P4', 'V4'),
      ],
      vehiclePositions: [],
    };
    const snapshot = engine.refresh(rt, nowAt('08:08'))[0]!;
    const route = route1(snapshot);
    expect(route.layovers.some((l) => l.tripId === 'D2')).toBe(false);
    expect(route.incoming.some((i) => i.tripId === 'D2')).toBe(false);
  });

  it('records terminal arrival from a vehicle position at the last stop, overriding the TU prediction', () => {
    const engine = makeEngine();
    const base: RealtimeSnapshot = {
      timestamp: unixAt('08:08'),
      tripUpdates: [
        depUpdate('D1', 'V1', '08:05'),
        arrUpdate('P1', 'V1'),
        arrUpdate('P2', 'V2'),
        arrUpdate('P3', 'V3'),
        arrUpdate('P4', 'V4'),
      ],
      vehiclePositions: [
        vpAtStop('V1', 'D1', 'MID', '08:12'),
        vpAtStop('V2', 'P2', 'T', '08:07', 1),
        // V3 on the inbound leg, not yet at the terminal.
        vpAtStop('V3', 'P3', 'MID', '08:18'),
      ],
    };
    // V3 inbound mid-route: D3 is an estimated layover (TU prediction passed, no recorded arrival).
    const before = route1(engine.refresh(base, nowAt('08:18'))[0]!);
    const d3Est = before.layovers.find((l) => l.tripId === 'D3')!;
    expect(d3Est.terminalArrivalSource).toBe('estimated');
    expect(d3Est.terminalArrival).toBeUndefined();

    // Now a fresh engine observes V3 parked at the terminal's last stop: the recorded arrival
    // overrides the TU prediction (first parked observation arms and commits with confirmPings=1).
    const fresh = makeEngine();
    const withVp: RealtimeSnapshot = {
      timestamp: unixAt('08:19'),
      tripUpdates: [
        depUpdate('D1', 'V1', '08:05'),
        arrUpdate('P1', 'V1'),
        arrUpdate('P2', 'V2'),
        arrUpdate('P3', 'V3'),
        arrUpdate('P4', 'V4'),
      ],
      vehiclePositions: [vpAtStop('V3', 'P3', 'T', '08:19', 1)],
    };
    const snapshot = fresh.refresh(withVp, nowAt('08:19'))[0]!;
    const d3 = route1(snapshot).layovers.find((l) => l.tripId === 'D3')!;
    expect(d3.terminalArrival).toBe(svc('08:19'));
    expect(d3.terminalArrivalSource).toBe('observed');
    expect(d3.scheduledArrival).toBe(svc('08:18'));
    expect(d3.expectedDeparture).toBe(svc('08:24'));
  });

  it('records arrival from VP when the trip never crossed the TU prediction threshold', () => {
    const engine = makeEngine();
    const rt: RealtimeSnapshot = {
      timestamp: unixAt('08:26'),
      tripUpdates: [],
      vehiclePositions: [vpAtStop('V4', 'P4', 'T', '08:26', 1)],
    };
    const snapshot = engine.refresh(rt, nowAt('08:26'))[0]!;
    const d4 = route1(snapshot).layovers.find((l) => l.tripId === 'D4')!;
    expect(d4.terminalArrival).toBe(svc('08:26'));
  });

  it('records departure when the vehicle sequence advances past the terminal first stop', () => {
    const engine = makeEngine();
    const layoverRt: RealtimeSnapshot = {
      timestamp: unixAt('08:08'),
      tripUpdates: [arrUpdate('P2', 'V2')],
      vehiclePositions: [vpAtStop('V2', 'D2', 'T', '08:08', 0)],
    };
    const before = engine.refresh(layoverRt, nowAt('08:08'))[0]!;
    expect(route1(before).layovers.some((l) => l.tripId === 'D2')).toBe(true);

    const enRouteRt: RealtimeSnapshot = {
      ...layoverRt,
      timestamp: unixAt('08:12'),
      vehiclePositions: [vpAtStop('V2', 'D2', 'MID', '08:12')],
    };
    const after = engine.refresh(enRouteRt, nowAt('08:12'))[0]!;
    const route = route1(after);
    expect(route.layovers.some((l) => l.tripId === 'D2')).toBe(false);
    const d2 = route.departed.find((d) => d.tripId === 'D2')!;
    expect(d2.departureSeconds).toBe(svc('08:12'));
  });

  it('records departure via trip flip when the sequence signal was missed', () => {
    const engine = makeEngine();
    const layoverRt: RealtimeSnapshot = {
      timestamp: unixAt('08:08'),
      tripUpdates: [],
      vehiclePositions: [vpAtStop('V1', 'D1', 'T', '08:08', 0)],
    };
    engine.refresh(layoverRt, nowAt('08:08'));

    const flippedRt: RealtimeSnapshot = {
      ...layoverRt,
      timestamp: unixAt('08:15'),
      vehiclePositions: [vpAtStop('V1', 'P3', 'B', '08:15', 0)],
    };
    const snapshot = engine.refresh(flippedRt, nowAt('08:15'))[0]!;
    const d1 = route1(snapshot).departed.find((d) => d.tripId === 'D1')!;
    expect(d1.departureSeconds).toBe(svc('08:15'));
  });

  it('clamps a future-dated vehicle position timestamp to now', () => {
    const engine = makeEngine();
    const rt: RealtimeSnapshot = {
      timestamp: unixAt('08:26'),
      tripUpdates: [],
      vehiclePositions: [vpAtStop('V4', 'P4', 'T', '08:31', 1)],
    };
    const snapshot = engine.refresh(rt, nowAt('08:26'))[0]!;
    const d4 = route1(snapshot).layovers.find((l) => l.tripId === 'D4')!;
    expect(d4.terminalArrival).toBe(svc('08:26'));
  });

  it('arms an arrival on the first parked ping and commits on the second with the production default', () => {
    // Production keeps confirmPings=2; a single parked observation must not record a fact.
    const engine = makeEngine();
    const parked: RealtimeSnapshot = {
      timestamp: unixAt('08:08'),
      tripUpdates: [arrUpdate('P2', 'V2')],
      vehiclePositions: [vpAtStop('V2', 'P2', 'T', '08:08')],
    };
    // Force the production two-ping default for this scenario.
    testData(engine).config.confirmPings = 2;
    testData(engine).config.departPings = 2;

    const first = route1(engine.refresh(parked, nowAt('08:08'))[0]!);
    // Armed but not committed: the bus shows as layover (parked in buffer) but has no fact yet.
    const d2First = first.layovers.find((l) => l.tripId === 'D2')!;
    expect(d2First.terminalArrival).toBeUndefined();
    expect(d2First.terminalArrivalSource).toBe('estimated');
    expect(engine.getVehiclePositionDiagnostics()[0]!.reasons).toContain('arrival_armed');

    const second = route1(engine.refresh(parked, nowAt('08:09'))[0]!);
    const d2 = second.layovers.find((l) => l.tripId === 'D2')!;
    expect(d2.terminalArrival).toBe(svc('08:08'));
    expect(d2.terminalArrivalSource).toBe('observed');
  });

  it('records an arrival from proximity to the terminal even without a stop match', () => {
    const engine = makeEngine();
    const rt: RealtimeSnapshot = {
      timestamp: unixAt('08:08'),
      tripUpdates: [arrUpdate('P2', 'V2')],
      // No stopId: proximity alone (lat/lon within the 150m buffer of terminal stop T) arms the layover.
      vehiclePositions: [
        {
          vehicleId: 'V2',
          tripId: 'P2',
          lat: 41.800001,
          lon: -87.600001,
          timestamp: unixAt('08:08'),
        },
      ],
    };
    const snapshot = engine.refresh(rt, nowAt('08:08'))[0]!;
    const d2 = route1(snapshot).layovers.find((l) => l.tripId === 'D2')!;
    expect(d2.terminalArrival).toBe(svc('08:08'));
    expect(d2.terminalArrivalSource).toBe('observed');
  });

  it('treats a bus parked at the terminal as layover even when no TU prediction exists (stuck-incoming fix)', () => {
    const engine = makeEngine();
    const rt: RealtimeSnapshot = {
      timestamp: unixAt('08:08'),
      tripUpdates: [],
      // P2 arrived at T but CTA provides no TU prediction for its terminal arrival. Previously the
      // bus stayed "incoming" forever; geometric posture must move it to layover immediately.
      vehiclePositions: [vpAtStop('V2', 'P2', 'T', '08:08')],
    };
    const snapshot = engine.refresh(rt, nowAt('08:08'))[0]!;
    const route = route1(snapshot);
    expect(route.incoming.some((i) => i.tripId === 'P2')).toBe(false);
    const d2 = route.layovers.find((l) => l.tripId === 'D2')!;
    expect(d2.terminalArrival).toBe(svc('08:08'));
  });

  it('records a departure when a laid-over bus leaves the terminal buffer under motion', () => {
    const engine = makeEngine();
    const layoverRt: RealtimeSnapshot = {
      timestamp: unixAt('08:08'),
      tripUpdates: [arrUpdate('P2', 'V2')],
      vehiclePositions: [vpAtStop('V2', 'P2', 'T', '08:08')],
    };
    engine.refresh(layoverRt, nowAt('08:08'));
    expect(route1(engine.refresh(layoverRt, nowAt('08:09'))[0]!).layovers.some((l) => l.tripId === 'D2')).toBe(true);

    const leftRt: RealtimeSnapshot = {
      timestamp: unixAt('08:12'),
      tripUpdates: [arrUpdate('P2', 'V2')],
      // The vehicle moved past the terminal stop-1 anchor and out of buffer.
      vehiclePositions: [vpAtStop('V2', 'D2', 'MID', '08:12')],
    };
    const after = route1(engine.refresh(leftRt, nowAt('08:12'))[0]!);
    expect(after.layovers.some((l) => l.tripId === 'D2')).toBe(false);
    const d2 = after.departed.find((d) => d.tripId === 'D2')!;
    expect(d2.departureSeconds).toBe(svc('08:12'));
  });

  it('latches a layover on hold-zone dwell even while the bus is moving in the terminal', () => {
    const engine = makeEngine();
    // confirmPings stays at the production default of 2; two hold-zone dwell pings (parked or
    // inching) commit the arrival to observed, so the bus latches rather than flickering.
    testData(engine).config.confirmPings = 2;
    testData(engine).config.departPings = 2;
    const first: RealtimeSnapshot = {
      timestamp: unixAt('08:20'),
      tripUpdates: [],
      vehiclePositions: [vpAtStop('V3', 'P3', 'T', '08:20')],
    };
    engine.refresh(first, nowAt('08:20'));
    // Second ping: still inside the hold zone (≈55m from T) but moving (>20m displacement from
    // the first ping). Hold-zone dwell tolerates this inching, so the arm latches to observed on
    // the second ping rather than bouncing back to incoming.
    const moving: RealtimeSnapshot = {
      timestamp: unixAt('08:21'),
      tripUpdates: [],
      vehiclePositions: [
        {
          vehicleId: 'V3',
          tripId: 'P3',
          lat: 41.8005,
          lon: -87.6,
          timestamp: unixAt('08:21'),
        },
      ],
    };
    const snapshot = engine.refresh(moving, nowAt('08:21'))[0]!;
    const route = route1(snapshot);
    expect(route.incoming.some((i) => i.tripId === 'P3')).toBe(false);
    const d3 = route.layovers.find((l) => l.tripId === 'D3')!;
    expect(d3.terminalArrivalSource).toBe('observed');
    expect(d3.terminalArrival).toBe(svc('08:20'));
  });

  it('does not fabricate an inbound card for a scheduled trip with no live vehicle', () => {
    const engine = makeEngine();
    // All four block predecessors (P1..P4) are scheduled in the static feed, but no realtime
    // vehicle is assigned to D1/D2/D3/D4 in the lookahead window. A scheduled trip that is not
    // active in GTFS-RT (likely missed/cancelled) must not appear as a phantom incoming bus.
    const rt: RealtimeSnapshot = {
      timestamp: unixAt('08:08'),
      tripUpdates: [],
      vehiclePositions: [],
    };
    const snapshot = engine.refresh(rt, nowAt('08:08'))[0]!;
    expect(snapshot.routes[0]!.incoming).toEqual([]);
    expect(snapshot.routes[0]!.layovers).toEqual([]);
  });

  it('keeps a layover when the bus inches forward within the terminal (no drop / no false departure)', () => {
    const engine = makeEngine();
    testData(engine).config.confirmPings = 2;
    testData(engine).config.departPings = 2;
    const rt: RealtimeSnapshot = {
      timestamp: unixAt('08:08'),
      tripUpdates: [],
      vehiclePositions: [vpAtStop('V2', 'P2', 'T', '08:08')],
    };
    // First parked ping arms; second parked ping commits the arrival.
    engine.refresh(rt, nowAt('08:08'));
    engine.refresh(rt, nowAt('08:09'));
    expect(route1(engine.refresh(rt, nowAt('08:10'))[0]!).layovers.some((l) => l.tripId === 'D2')).toBe(true);

    // The bus inches forward within the terminal: still in the hold zone (movement allowance),
    // so it must remain a layover and must NOT be recorded as departed.
    const inchedRt: RealtimeSnapshot = {
      timestamp: unixAt('08:12'),
      tripUpdates: [],
      vehiclePositions: [
        {
          vehicleId: 'V2',
          tripId: 'P2',
          lat: 41.801,
          lon: -87.6, // ~110m north of terminal stop T: inside 150m radius + 75m movement allowance
          timestamp: unixAt('08:12'),
        },
      ],
    };
    const after = route1(engine.refresh(inchedRt, nowAt('08:12'))[0]!);
    expect(after.layovers.some((l) => l.tripId === 'D2')).toBe(true);
    expect(after.departed.some((d) => d.tripId === 'D2')).toBe(false);
    expect(engine.getFactEventDiagnostics().some((e) => e.action === 'departure')).toBe(false);
  });

  it('records a departure only once a layover leaves the terminal hold zone under motion', () => {
    const engine = makeEngine();
    testData(engine).config.confirmPings = 2;
    testData(engine).config.departPings = 2;
    const rt: RealtimeSnapshot = {
      timestamp: unixAt('08:08'),
      tripUpdates: [],
      vehiclePositions: [vpAtStop('V2', 'P2', 'T', '08:08')],
    };
    engine.refresh(rt, nowAt('08:08'));
    engine.refresh(rt, nowAt('08:09'));
    engine.refresh(rt, nowAt('08:10'));
    expect(route1(engine.refresh(rt, nowAt('08:11'))[0]!).layovers.some((l) => l.tripId === 'D2')).toBe(true);

    // Bus leaves the hold zone: well beyond terminal T and moving (displacement > 20m).
    const leftRt: RealtimeSnapshot = {
      timestamp: unixAt('08:14'),
      tripUpdates: [],
      vehiclePositions: [
        {
          vehicleId: 'V2',
          tripId: 'D2',
          lat: 41.72,
          lon: -87.69, // ~9km from terminal: clearly departed
          timestamp: unixAt('08:14'),
        },
      ],
    };
    const after = route1(engine.refresh(leftRt, nowAt('08:14'))[0]!);
    expect(after.layovers.some((l) => l.tripId === 'D2')).toBe(false);
    expect(after.departed.some((d) => d.tripId === 'D2')).toBe(true);
  });

  it('classifies a first-of-block bus as layover from TU assignment at the terminal (no inbound leg)', () => {
    const engine = makeEngine();
    // V9 has no VP trip (deadhead / non-rev leg not in static) and is parked at terminal T.
    // TU operates outbound trip D5 (first trip of its block, no block predecessor). Posture
    // + TU assignment must classify it as layover without any inbound trip identity.
    const rt: RealtimeSnapshot = {
      timestamp: unixAt('08:35'),
      tripUpdates: [
        {
          tripId: 'D5',
          vehicleId: 'V9',
          stopTimeUpdates: [
            { stopId: 'T', stopSequence: 0, departureTime: unixAt('08:35') },
          ],
          timestamp: 1700000000,
        },
      ],
      vehiclePositions: [{ vehicleId: 'V9', lat: 41.8, lon: -87.6, timestamp: unixAt('08:35') }],
    };
    const snapshot = engine.refresh(rt, nowAt('08:35'))[0]!;
    const route = route1(snapshot);
    const d5 = route.layovers.find((l) => l.tripId === 'D5')!;
    expect(d5.vehicleId).toBe('V9');
    expect(d5.terminalArrivalSource).toBe('estimated');
    // A bus not present at the terminal must not be pulled into layover by TU assignment alone.
    const elsewhere: RealtimeSnapshot = {
      timestamp: unixAt('08:35'),
      tripUpdates: [
        { tripId: 'D5', vehicleId: 'V9', stopTimeUpdates: [], timestamp: 1700000000 },
      ],
      vehiclePositions: [{ vehicleId: 'V9', lat: 41.6, lon: -87.9, timestamp: unixAt('08:35') }],
    };
    const snapshot2 = route1(engine.refresh(elsewhere, nowAt('08:35'))[0]!);
    expect(snapshot2.layovers.some((l) => l.tripId === 'D5')).toBe(false);
  });

  it('latches a layover after dwell so it does not flicker back to incoming', () => {
    const engine = makeEngine();
    testData(engine).config.confirmPings = 2;
    testData(engine).config.departPings = 2;
    const parked: RealtimeSnapshot = {
      timestamp: unixAt('08:08'),
      tripUpdates: [arrUpdate('P2', 'V2')],
      vehiclePositions: [vpAtStop('V2', 'P2', 'T', '08:08')],
    };
    engine.refresh(parked, nowAt('08:08'));
    engine.refresh(parked, nowAt('08:09'));
    // Dwell latches: arrival is recorded, so D2 is a layover.
    expect(route1(engine.refresh(parked, nowAt('08:10'))[0]!).layovers.some((l) => l.tripId === 'D2')).toBe(true);

    // A refresh with no live posture or TU for the vehicle (feed gap) must NOT demote it to
    // incoming: the recorded arrival keeps it latched as layover.
    const gap: RealtimeSnapshot = {
      timestamp: unixAt('08:11'),
      tripUpdates: [],
      vehiclePositions: [],
    };
    const after = route1(engine.refresh(gap, nowAt('08:11'))[0]!);
    expect(after.layovers.some((l) => l.tripId === 'D2')).toBe(true);
    expect(after.incoming.some((i) => i.tripId === 'P2')).toBe(false);
  });
});
