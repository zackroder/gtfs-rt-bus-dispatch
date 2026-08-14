import { describe, expect, it } from 'vitest';
import { createDatabase } from '../db/schema';
import { loadStatic } from '../db/staticLoader';
import { Engine } from './engine';
import { syntheticGtfs } from '../test/fixtures';
import type { TripSpec } from '../test/fixtures';
import type { RealtimeSnapshot } from '../providers/types';
import type { AppConfig, TripUpdateInfo, VehiclePositionInfo } from '../../../shared/types';

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
  ];
}

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
  };
  return new Engine(db, () => cfg);
}

function stdRt(): RealtimeSnapshot {
  return {
    timestamp: unixAt('08:08'),
    tripUpdates: [
      depUpdate('D1', 'V1', '08:05'),
      arrUpdate('P1', 'V1'),
      arrUpdate('P2', 'V2'),
      arrUpdate('P3', 'V3'),
      arrUpdate('P4', 'V4'),
    ],
    vehiclePositions: [],
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
    timestamp: unixAt(hhmm),
  };
}

function route1(snapshot: ReturnType<Engine['refresh']>[number]) {
  return snapshot.routes.find((r) => r.routeId === '1')!;
}

describe('engine triplet dispatch', () => {
  it('holds the center to even headways and propagates the locked hold to the next triplet', () => {
    const engine = makeEngine();
    const rt = stdRt();

    const first = engine.refresh(rt, nowAt('08:08'))[0]!;
    const routeA = route1(first);
    expect(routeA.interventions).toHaveLength(1);
    const hold = routeA.interventions[0]!;
    expect(hold.rule).toBe('hold');
    expect(hold.holdSeconds).toBe(120);
    expect(hold.until).toBe(svc('08:14'));
    expect(hold.vehicleId).toBe('V2');

    const d2 = routeA.layovers.find((l) => l.tripId === 'D2')!;
    expect(d2.hold?.holdSeconds).toBe(120);
    expect(d2.predictedDeparture).toBe(svc('08:14'));

    const second = engine.refresh(rt, nowAt('08:18'))[0]!;
    const routeB = route1(second);
    expect(routeB.interventions).toEqual([]);
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
      vehiclePositions: [],
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
    expect(d3.terminalArrival).toBe(svc('08:18'));
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
    expect(d4.terminalArrival).toBe(svc('08:25'));
    expect(d4.scheduledArrival).toBe(svc('08:25'));
    expect(d4.expectedDeparture).toBe(svc('08:30'));
    expect(d4.restDelayed).toBe(false);
    expect(d4.predictedDeparture).toBe(svc('08:30'));
  });

  it('counts down to the effective held departure', () => {
    const engine = makeEngine();
    const snapshot = engine.refresh(stdRt(), nowAt('08:08'))[0]!;
    const route = route1(snapshot);
    const d2 = route.layovers.find((l) => l.tripId === 'D2')!;
    expect(d2.countdownSeconds).toBe(svc('08:14') - svc('08:08'));
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

  it('records departures globally so recently-departed survives unviewed gaps', () => {
    const engine = makeEngine();
    const rt = stdRt();
    engine.refresh(rt, nowAt('08:08'), new Set());
    const snapshot = engine.refresh(rt, nowAt('08:08'))[0]!;
    const route = route1(snapshot);
    const d1 = route.departed.find((d) => d.tripId === 'D1')!;
    expect(d1.departureSeconds).toBe(svc('08:05'));
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
    const later: RealtimeSnapshot = {
      timestamp: unixAt('08:20'),
      tripUpdates: [
        depUpdate('D1', 'V1', '08:05'),
        depUpdate('D2', 'V2', '08:16'),
        arrUpdate('P3', 'V3'),
        arrUpdate('P4', 'V4'),
      ],
      vehiclePositions: [],
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
      vehiclePositions: [],
    };
    const snapshot = engine.refresh(rt, nowAt('08:08'))[0]!;
    const route = route1(snapshot);
    expect(route.departed.some((d) => d.tripId === 'D2')).toBe(false);
    expect(route.layovers.some((l) => l.tripId === 'D2')).toBe(true);
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
    const tuOnly = stdRt();
    engine.refresh(tuOnly, nowAt('08:18'), new Set());
    const d3First = route1(engine.refresh(tuOnly, nowAt('08:18'))[0]!).layovers.find((l) => l.tripId === 'D3')!;
    expect(d3First.terminalArrival).toBe(svc('08:18'));

    const withVp: RealtimeSnapshot = {
      ...tuOnly,
      vehiclePositions: [vpAtStop('V3', 'P3', 'T', '08:19', 1)],
    };
    const snapshot = engine.refresh(withVp, nowAt('08:19'))[0]!;
    const d3 = route1(snapshot).layovers.find((l) => l.tripId === 'D3')!;
    expect(d3.terminalArrival).toBe(svc('08:19'));
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
});
