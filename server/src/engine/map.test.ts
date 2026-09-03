import { describe, expect, it } from 'vitest';
import { createDatabase } from '../db/schema';
import { loadStatic } from '../db/staticLoader';
import { InterventionStore } from '../db/interventions';
import { Engine } from './engine';
import { syntheticGtfs } from '../test/fixtures';
import type { AppConfig, TerminalSnapshot, VehiclePositionInfo } from '../../../shared/types';
import type { RealtimeSnapshot } from '../providers/types';

// The map is a pure projection of a cached snapshot onto a raw realtime feed, so these tests
// drive engine state directly and hand buildMapSnapshot a hand-built snapshot DTO plus VP feed.

const START = 8 * 3600;

function vp(vehicleId: string, lat: number, lon: number, bearing?: number): VehiclePositionInfo {
  return {
    vehicleId,
    tripId: undefined,
    lat,
    lon,
    bearing,
    timestamp: 1700000000,
  };
}

function makeEngine(): { engine: Engine; config: AppConfig } {
  const gtfs = syntheticGtfs({
    stops: [
      { stopId: 'T', name: 'Terminal', lat: 41.8, lon: -87.6 },
      { stopId: 'B', name: 'Far Stop', lat: 41.7, lon: -87.7 },
    ],
    // A minimal outbound trip keeps stop T in the static projection so its coordinates load into
    // the stop cache; the map tests only read the schema, not the trip identities.
    trips: [
      { tripId: 'D1', stopTimes: [{ stopId: 'T', arr: '08:00:00', dep: '08:00:00', pickup: 0 }] },
    ],
  });
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
    terminalMovementMeters: 75,
    departureTriggerMeters: 75,
  };
  const engine = new Engine(db, () => config, new InterventionStore(db));
  return { engine, config };
}

function mkSnapshot(overrides: Partial<TerminalSnapshot> = {}): TerminalSnapshot {
  return {
    terminalId: 'T',
    generatedAt: 1700000000,
    serviceDayStartSeconds: START,
    routes: [
      {
        routeId: '1',
        routeShortName: '1',
        color: 'FFB81C',
        incoming: [],
        layovers: [],
        departed: [],
        interventions: [],
      },
    ],
    ...overrides,
  };
}

const emptyRt: RealtimeSnapshot = { timestamp: 1700000000, tripUpdates: [], vehiclePositions: [] };

describe('buildMapSnapshot', () => {
  it('derives the five vehicle statuses from the snapshot DTO groups', () => {
    const { engine } = makeEngine();
    const snapshot = mkSnapshot({
      routes: [{
        routeId: '1',
        routeShortName: '1',
        color: 'FFB81C',
        incoming: [
          { routeId: '1', routeShortName: '1', tripId: 'I1', vehicleId: 'V1', scheduledArrival: 0, predictedArrival: 0, etaSeconds: 120, delaySeconds: 0, nextTripId: 'D1', nextDestination: 'B', scheduledDeparture: 0, expectedDeparture: 0 },
        ],
        layovers: [
          { routeId: '1', routeShortName: '1', tripId: 'L1a', arrivalPending: true, vehicleId: 'V2', scheduledDeparture: 0, scheduledArrival: 0, expectedDeparture: 0, predictedDeparture: 0, countdownSeconds: 0 },
          { routeId: '1', routeShortName: '1', tripId: 'L1b', vehicleId: 'V3', scheduledDeparture: 0, scheduledArrival: 0, expectedDeparture: 0, predictedDeparture: 0, countdownSeconds: 0 },
          { routeId: '1', routeShortName: '1', tripId: 'L1c', departurePending: true, vehicleId: 'V4', scheduledDeparture: 0, scheduledArrival: 0, expectedDeparture: 0, predictedDeparture: 0, countdownSeconds: 0 },
        ],
        departed: [
          { routeId: '1', routeShortName: '1', tripId: 'L1d', vehicleId: 'V5', scheduledDeparture: 0, departureSeconds: 0 },
        ],
        interventions: [],
      }],
    });
    const rt: RealtimeSnapshot = {
      timestamp: 1700000000,
      tripUpdates: [],
      vehiclePositions: [
        vp('V1', 41.75, -87.65),
        vp('V2', 41.799, -87.601),
        vp('V3', 41.8, -87.6),
        vp('V4', 41.8005, -87.6),
        vp('V5', 41.81, -87.58),
      ],
    };
    const map = engine.buildMapSnapshot('T', snapshot, rt);
    const byVehicle = new Map(map.vehicles.map((m) => [m.vehicleId, m.status]));
    expect(byVehicle.get('V1')).toBe('inbound');
    expect(byVehicle.get('V2')).toBe('arriving');
    expect(byVehicle.get('V3')).toBe('laying_over');
    expect(byVehicle.get('V4')).toBe('departing');
    expect(byVehicle.get('V5')).toBe('departed');
    expect(map.vehicles).toHaveLength(5);
  });

  it('exposes the three buffer circles with the configured radii and kinds', () => {
    const { engine } = makeEngine();
    const map = engine.buildMapSnapshot('T', mkSnapshot(), emptyRt);
    const arrival = map.buffers.find((b) => b.kind === 'arrival')!;
    const movement = map.buffers.find((b) => b.kind === 'movement')!;
    const departure = map.buffers.find((b) => b.kind === 'departure')!;
    expect(arrival).toMatchObject({ stopId: 'T', radiusMeters: 150, kind: 'arrival', lat: 41.8, lon: -87.6 });
    // Movement/hysteresis is the arrival radius plus the terminal movement allowance.
    expect(movement.radiusMeters).toBe(150 + 75);
    expect(movement.kind).toBe('movement');
    expect(departure.radiusMeters).toBe(75);
    expect(departure.kind).toBe('departure');
    // A per-terminal radius override replaces the global arrival default.
    expect(map.buffers.filter((b) => b.kind === 'arrival')[0]!.radiusMeters).toBe(150);
  });

  it('honors the per-terminal radiusMeters override for the arrival circle', () => {
    const { engine, config } = makeEngine();
    config.terminals = [{ id: 'T', name: 'Terminal', stopIds: ['T'], radiusMeters: 225, routeIds: ['1'] }];
    const map = engine.buildMapSnapshot('T', mkSnapshot(), emptyRt);
    const arrival = map.buffers.find((b) => b.kind === 'arrival')!;
    expect(arrival.radiusMeters).toBe(225);
    const movement = map.buffers.find((b) => b.kind === 'movement')!;
    expect(movement.radiusMeters).toBe(225 + 75);
  });

  it('sets the arrow heading from the feed bearing when present, else towards/away the center', () => {
    const { engine } = makeEngine();
    const snapshot = mkSnapshot({
      routes: [{
        routeId: '1',
        routeShortName: '1',
        incoming: [],
        layovers: [],
        departed: [{ routeId: '1', routeShortName: '1', tripId: 'D1', vehicleId: 'VD', scheduledDeparture: 0, departureSeconds: 0 }],
        interventions: [],
      }],
    });
    // Departing/departed arrows point away from the terminal (bearing from center to the bus).
    const withFeedBearing = engine.buildMapSnapshot('T', snapshot, {
      timestamp: 1700000000,
      tripUpdates: [],
      vehiclePositions: [vp('VD', 41.82, -87.58, 177)],
    });
    expect(withFeedBearing.vehicles[0]!.headingDegrees).toBe(177);

    const noFeedBearing = engine.buildMapSnapshot('T', snapshot, {
      timestamp: 1700000000,
      tripUpdates: [],
      vehiclePositions: [vp('VD', 41.82, -87.58)],
    });
    // The bus is east-northeast of the center (41.8,-87.6); away-from-center heading wraps negative to 0..360.
    const heading = noFeedBearing.vehicles[0]!.headingDegrees!;
    expect(heading).toBeGreaterThanOrEqual(0);
    expect(heading).toBeLessThan(360);
  });

  it('computes toward-center heading for an approaching bus when the feed omits bearing', () => {
    const { engine } = makeEngine();
    const snapshot = mkSnapshot({
      routes: [{
        routeId: '1',
        routeShortName: '1',
        incoming: [
          { routeId: '1', routeShortName: '1', tripId: 'I1', vehicleId: 'VI', scheduledArrival: 0, predictedArrival: 0, etaSeconds: 60, delaySeconds: 0, nextTripId: 'D1', nextDestination: 'B', scheduledDeparture: 0, expectedDeparture: 0 },
        ],
        layovers: [],
        departed: [],
        interventions: [],
      }],
    });
    // The bus is due east of the center, so the toward-center bearing is ~270 (west).
    const map = engine.buildMapSnapshot('T', snapshot, {
      timestamp: 1700000000,
      tripUpdates: [],
      vehiclePositions: [vp('VI', 41.8, -87.58)],
    });
    const marker = map.vehicles[0]!;
    expect(marker.status).toBe('inbound');
    // 270 +/- a small equirectangular error bucket.
    expect(marker.headingDegrees!).toBeGreaterThan(260);
    expect(marker.headingDegrees!).toBeLessThan(280);
  });

  it('skips vehicles without a matching VP coordinate', () => {
    const { engine } = makeEngine();
    const snapshot = mkSnapshot({
      routes: [{
        routeId: '1',
        routeShortName: '1',
        incoming: [],
        layovers: [],
        departed: [{ routeId: '1', routeShortName: '1', tripId: 'D1', vehicleId: 'VX', scheduledDeparture: 0, departureSeconds: 0 }],
        interventions: [],
      }],
    });
    const map = engine.buildMapSnapshot('T', snapshot, emptyRt);
    expect(map.vehicles).toEqual([]);
  });

  it('throws for an unknown terminal', () => {
    const { engine } = makeEngine();
    expect(() => engine.buildMapSnapshot('NOPE', mkSnapshot(), emptyRt)).toThrow('unknown terminal');
  });
});
