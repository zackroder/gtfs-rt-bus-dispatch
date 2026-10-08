import { describe, expect, it } from 'vitest';
import { createDatabase } from '../db/schema';
import { loadStatic } from '../db/staticLoader';
import { Engine } from './engine';
import { InterventionStore } from '../db/interventions';
import { syntheticGtfs, type TripSpec } from '../test/fixtures';
import type { RealtimeSnapshot } from '../providers/types';
import type { AppConfig } from '../../../shared/types';

// The chunked decision pass (plan Phase 10a) must build the same snapshots as the synchronous
// refresh while yielding to the event loop between bounded slices. Fixtures use a single stop
// shared by many terminals so the pass has enough units to slice without a large schedule.

function nowAt(hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  // UTC instants + the UTC agency timezone below make the fixture wall clock equal the GTFS clock.
  return new Date(Date.UTC(2026, 7, 13, h!, m!, 0));
}

function fixtureTrips(): TripSpec[] {
  return ['08:10:00', '08:20:00', '08:30:00'].map((dep, index) => ({
    tripId: `D${index + 1}`,
    blockId: `B${index + 1}`,
    stopTimes: [
      { stopId: 'T', arr: dep, dep, pickup: 0 },
      { stopId: 'B', arr: '09:00:00', dep: '09:00:00', dropOff: 0 },
    ],
  }));
}

function makeEngine(terminalCount = 10): Engine {
  const db = createDatabase(':memory:');
  loadStatic(db, syntheticGtfs({ trips: fixtureTrips() }));
  const terminals = Array.from({ length: terminalCount }, (_, index) => ({
    id: `T${index}`,
    name: `Terminal ${index}`,
    stopIds: ['T'],
    routeIds: ['1'],
  }));
  const cfg: AppConfig = {
    realtime: { tripUpdatesUrl: 'http://localhost/tu.pb' },
    staticGtfsUrl: 'http://localhost/gtfs.zip',
    agencyTimezone: 'UTC',
    refreshIntervalSeconds: 10,
    staticRefreshHours: 24,
    minRestMinutes: 5,
    maxHoldMinutes: 10,
    leadTimeMinutes: 5,
    lookaheadMinutes: 90,
    terminals,
    arrivalRadiusMeters: 150,
    stationaryDisplacementMeters: 20,
    confirmPings: 1,
    departPings: 1,
  };
  return new Engine(db, () => cfg, new InterventionStore(db));
}

function emptyRt(): RealtimeSnapshot {
  return {
    timestamp: Math.floor(Date.UTC(2026, 7, 13, 8, 8) / 1000),
    tripUpdates: [],
    vehiclePositions: [],
  };
}

describe('chunked decision refresh', () => {
  it('produces output identical to the unchunked refresh', async () => {
    const sync = makeEngine().refresh(emptyRt(), nowAt('08:08'));
    const chunked = await makeEngine().refreshChunked(emptyRt(), nowAt('08:08'), undefined, {
      sliceSize: 3,
      sliceBudgetMs: 1_000_000,
    });
    expect(chunked).toEqual(sync);
    expect(chunked).toHaveLength(10);
  });

  it('yields between slices so interleaved work is served while the pass runs', async () => {
    const engine = makeEngine();
    let served = 0;
    const snapshots = await engine.refreshChunked(emptyRt(), nowAt('08:08'), undefined, {
      sliceSize: 2,
      sliceBudgetMs: 1_000_000,
      yieldToEventLoop: async () => {
        served++;
      },
    });
    expect(snapshots).toHaveLength(10);
    // 10 terminals in slices of 2 yield four times (no yield after the final slice).
    expect(served).toBe(4);
  });

  it('uses the time budget to bound a slice', async () => {
    const engine = makeEngine();
    let clock = 0;
    let served = 0;
    const snapshots = await engine.refreshChunked(emptyRt(), nowAt('08:08'), undefined, {
      sliceSize: 1000,
      sliceBudgetMs: 250,
      now: () => {
        clock += 100;
        return clock;
      },
      yieldToEventLoop: async () => {
        served++;
      },
    });
    expect(snapshots).toHaveLength(10);
    expect(served).toBeGreaterThan(0);
  });

  it('abandons the remaining terminals when shouldContinue turns false', async () => {
    const engine = makeEngine();
    let calls = 0;
    const snapshots = await engine.refreshChunked(emptyRt(), nowAt('08:08'), undefined, {
      sliceSize: 2,
      sliceBudgetMs: 1_000_000,
      yieldToEventLoop: async () => {},
      shouldContinue: () => {
        calls++;
        return calls < 2;
      },
    });
    expect(snapshots).toHaveLength(4);
  });
});
