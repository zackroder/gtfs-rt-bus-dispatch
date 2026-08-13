import { describe, expect, it } from 'vitest';
import { createDatabase } from '../db/schema';
import { loadStatic } from '../db/staticLoader';
import { Engine } from './engine';
import { syntheticGtfs } from '../test/fixtures';
import type { TripSpec } from '../test/fixtures';
import type { RealtimeSnapshot } from '../providers/types';
import type { AppConfig, TripUpdateInfo } from '../../../shared/types';

const START = 8 * 3600;

function svc(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 3600 + m! * 60 - START;
}

function nowAt(hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2026, 7, 13, h!, m!, 0);
}

function delayUpdate(tripId: string, vehicleId: string, arrivalDelay: number): TripUpdateInfo {
  return {
    tripId,
    vehicleId,
    stopTimeUpdates: [{ stopId: 'T', stopSequence: 99, arrivalDelay }],
    timestamp: 1700000000,
  };
}

function emptyRt(): RealtimeSnapshot {
  return { timestamp: 1700000000, vehicles: [], tripUpdates: [] };
}

function baseTrips(): TripSpec[] {
  return [
    {
      tripId: 'L1',
      blockId: 'A',
      stopTimes: [
        { stopId: 'T', arr: '08:00:00', dep: '08:00:00', pickup: 0 },
        { stopId: 'B', arr: '08:30:00', dep: '08:30:00', dropOff: 0 },
      ],
    },
    {
      tripId: 'L2',
      blockId: 'A',
      stopTimes: [
        { stopId: 'B', arr: '08:45:00', dep: '08:45:00', pickup: 0 },
        { stopId: 'T', arr: '09:10:00', dep: '09:10:00', dropOff: 0 },
      ],
    },
    {
      tripId: 'L3',
      blockId: 'A',
      stopTimes: [
        { stopId: 'T', arr: '10:00:00', dep: '10:00:00', pickup: 0 },
        { stopId: 'B', arr: '10:30:00', dep: '10:30:00', dropOff: 0 },
      ],
    },
    {
      tripId: 'F2',
      blockId: 'B',
      stopTimes: [
        { stopId: 'B', arr: '09:30:00', dep: '09:30:00', pickup: 0 },
        { stopId: 'T', arr: '10:00:00', dep: '10:00:00', dropOff: 0 },
      ],
    },
    {
      tripId: 'F3',
      blockId: 'B',
      stopTimes: [
        { stopId: 'T', arr: '10:12:00', dep: '10:12:00', pickup: 0 },
        { stopId: 'B', arr: '10:42:00', dep: '10:42:00', dropOff: 0 },
      ],
    },
  ];
}

function makeEngine(trips: TripSpec[], rt: RealtimeSnapshot, config?: Partial<AppConfig>) {
  const gtfs = syntheticGtfs({ trips });
  const db = createDatabase(':memory:');
  loadStatic(db, gtfs);
  const cfg: AppConfig = {
    realtime: {
      vehiclePositionsUrl: 'http://localhost/vp.pb',
      tripUpdatesUrl: 'http://localhost/tu.pb',
    },
    staticGtfsUrl: 'http://localhost/gtfs.zip',
    refreshIntervalSeconds: 10,
    staticRefreshHours: 24,
    minRestMinutes: 5,
    gapFactor: 1.5,
    bunchFactor: 0.5,
    holdFraction: 0.5,
    maxHoldMinutes: 10,
    leadTimeMinutes: 5,
    lookaheadMinutes: 90,
    terminals: [{ id: 'T', name: 'Terminal', stopIds: ['T'], routeIds: ['1'] }],
    ...config,
  };
  const engine = new Engine(db, () => cfg);
  return { engine, db, cfg };
}

function route1(snapshot: ReturnType<Engine['refresh']>[number]) {
  return snapshot.routes.find((r) => r.routeId === '1')!;
}

describe('engine interventions', () => {
  it('emits hold_leader with capped hold and override badge when follower is late', () => {
    const rt: RealtimeSnapshot = {
      timestamp: 1700000000,
      vehicles: [],
      tripUpdates: [delayUpdate('F2', 'VF', 1800)],
    };
    const { engine } = makeEngine(baseTrips(), rt);
    const snapshot = engine.refresh(rt, nowAt('09:57'))[0]!;
    const route = route1(snapshot);

    const hold = route.interventions.find((i) => i.rule === 'hold_leader');
    expect(hold).toBeDefined();
    expect(hold!.holdSeconds).toBe(600);
    expect(hold!.until).toBe(svc('10:10'));
    expect(hold!.vehicleId).toBeUndefined();

    const leader = route.layovers.find((l) => l.tripId === 'L3')!;
    expect(leader.hold).toBeDefined();
    expect(leader.hold!.holdSeconds).toBe(600);
    expect(leader.hold!.rule).toBe('leader');
    expect(leader.hold!.effectiveDeparture).toBe(svc('10:10'));
    expect(leader.countdownSeconds).toBe(svc('10:00') - svc('09:57'));

    const incoming = route.incoming.find((i) => i.tripId === 'F2')!;
    expect(incoming.predictedArrival).toBe(svc('10:30'));
    expect(incoming.delaySeconds).toBe(1800);
  });

  it('holds the follower to restore spacing when the leader is late', () => {
    const rt: RealtimeSnapshot = {
      timestamp: 1700000000,
      vehicles: [],
      tripUpdates: [delayUpdate('L2', 'VL', 3720), delayUpdate('F2', 'VF', 600)],
    };
    const { engine } = makeEngine(baseTrips(), rt);
    const snapshot = engine.refresh(rt, nowAt('09:57'))[0]!;
    const route = route1(snapshot);

    const hold = route.interventions.find((i) => i.rule === 'hold_follower');
    expect(hold).toBeDefined();
    expect(hold!.holdSeconds).toBe(480);
    expect(hold!.until).toBe(svc('10:20'));
    expect(hold!.vehicleId).toBe('VF');
  });

  it('caps follower hold at maxHoldMinutes', () => {
    const rt: RealtimeSnapshot = {
      timestamp: 1700000000,
      vehicles: [],
      tripUpdates: [delayUpdate('L2', 'VL', 3720)],
    };
    const { engine } = makeEngine(baseTrips(), rt);
    const snapshot = engine.refresh(rt, nowAt('09:57'))[0]!;
    const route = route1(snapshot);

    const hold = route.interventions.find((i) => i.rule === 'hold_follower');
    expect(hold).toBeDefined();
    expect(hold!.holdSeconds).toBe(600);
    expect(hold!.until).toBe(svc('10:22'));
  });

  it('emits a passive gap alert instead of holding when the leader is still inbound', () => {
    const rt: RealtimeSnapshot = {
      timestamp: 1700000000,
      vehicles: [],
      tripUpdates: [delayUpdate('L2', 'VL', 3720), delayUpdate('F2', 'VF', 3300)],
    };
    const { engine } = makeEngine(baseTrips(), rt);
    const snapshot = engine.refresh(rt, nowAt('09:57'))[0]!;
    const route = route1(snapshot);

    const alert = route.interventions.find((i) => i.rule === 'gap_alert');
    expect(alert).toBeDefined();
    expect(alert!.holdSeconds).toBe(0);
    expect(route.interventions.find((i) => i.rule === 'hold_leader')).toBeUndefined();
  });

  it('emits nothing when the predicted headway is within thresholds', () => {
    const { engine } = makeEngine(baseTrips(), emptyRt());
    const snapshot = engine.refresh(emptyRt(), nowAt('09:57'))[0]!;
    const route = route1(snapshot);
    expect(route.interventions).toEqual([]);
    expect(route.layovers.find((l) => l.tripId === 'L3')!.hold).toBeUndefined();
  });

  it('does not hold the leader before the lead-time window opens', () => {
    const rt: RealtimeSnapshot = {
      timestamp: 1700000000,
      vehicles: [],
      tripUpdates: [delayUpdate('F2', 'VF', 1800)],
    };
    const { engine } = makeEngine(baseTrips(), rt);
    const snapshot = engine.refresh(rt, nowAt('09:50'))[0]!;
    const route = route1(snapshot);
    expect(route.interventions.find((i) => i.rule === 'hold_leader')).toBeUndefined();
  });

  it('flags a min-rest advisory when the predicted layover is below the minimum', () => {
    const rt: RealtimeSnapshot = {
      timestamp: 1700000000,
      vehicles: [],
      tripUpdates: [delayUpdate('L2', 'VL', 2760)],
    };
    const { engine } = makeEngine(baseTrips(), rt);
    const snapshot = engine.refresh(rt, nowAt('09:57'))[0]!;
    const route = route1(snapshot);

    const advisory = route.interventions.find((i) => i.rule === 'min_rest');
    expect(advisory).toBeDefined();
    const layover = route.layovers.find((l) => l.tripId === 'L3')!;
    expect(layover.minRestAdvisory).toBe(true);
    expect(layover.hold).toBeUndefined();
  });
});
