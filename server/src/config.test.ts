import { describe, expect, it } from 'vitest';
import { createDatabase } from './db/schema';
import { applyConfig, loadConfig, setSetting, GEOMETRY_DEFAULTS } from './config';
import type { AppConfig } from '../../shared/types';

// Geometry knobs are optional in the schema so persisted configs from before the
// feature load transparently; loading must backfill defaults and persistence must
// round-trip operator overrides.
const minimalConfig: AppConfig = {
  realtime: {
    tripUpdatesUrl: 'http://localhost/tu.pb',
    vehiclePositionsUrl: 'http://localhost/vp.pb',
    apiKey: 'sekrit',
  },
  staticGtfsUrl: 'http://localhost/gtfs.zip',
  refreshIntervalSeconds: 10,
  staticRefreshHours: 24,
  minRestMinutes: 5,
  maxHoldMinutes: 10,
  leadTimeMinutes: 5,
  lookaheadMinutes: 90,
  terminals: [{ id: 'T1', name: 'T1', stopIds: ['S1'] }],
};

describe('config geometry knobs', () => {
  it('applies defaults to an env-derived config', () => {
    const db = createDatabase(':memory:');
    const config = loadConfig(db, {});
    expect(config.arrivalRadiusMeters).toBe(GEOMETRY_DEFAULTS.arrivalRadiusMeters);
    expect(config.terminalMovementMeters).toBe(GEOMETRY_DEFAULTS.terminalMovementMeters);
    expect(config.stationaryDisplacementMeters).toBe(GEOMETRY_DEFAULTS.stationaryDisplacementMeters);
    expect(config.confirmPings).toBe(GEOMETRY_DEFAULTS.confirmPings);
    expect(config.departPings).toBe(GEOMETRY_DEFAULTS.departPings);
    expect(config.scheduleArmGraceSeconds).toBe(GEOMETRY_DEFAULTS.scheduleArmGraceSeconds);
  });

  it('backfills geometry defaults for a pre-feature saved config', () => {
    const db = createDatabase(':memory:');
    // Persist a config from before the geometry feature: only the original keys exist.
    const legacy: Record<string, unknown> = { ...minimalConfig };
    delete legacy.arrivalRadiusMeters;
    delete legacy.terminalMovementMeters;
    delete legacy.stationaryDisplacementMeters;
    delete legacy.confirmPings;
    delete legacy.departPings;
    delete legacy.scheduleArmGraceSeconds;
    setSetting(db, 'appConfig', legacy);
    const config = loadConfig(db, {});
    expect(config.arrivalRadiusMeters).toBe(GEOMETRY_DEFAULTS.arrivalRadiusMeters);
    expect(config.terminalMovementMeters).toBe(GEOMETRY_DEFAULTS.terminalMovementMeters);
    expect(config.confirmPings).toBe(GEOMETRY_DEFAULTS.confirmPings);
  });

  it('round-trips operator geometry overrides through applyConfig', () => {
    const db = createDatabase(':memory:');
    const current = loadConfig(db, { CTA_API_KEY: 'sekrit' });
    const next: AppConfig = {
      ...current,
      arrivalRadiusMeters: 300,
      terminalMovementMeters: 120,
      confirmPings: 3,
      departPings: 4,
      scheduleArmGraceSeconds: 90,
      terminals: [{ ...minimalConfig.terminals[0]!, radiusMeters: 250 }],
    };
    const saved = applyConfig(db, current, next);
    expect(saved.arrivalRadiusMeters).toBe(300);
    expect(saved.terminalMovementMeters).toBe(120);
    expect(saved.confirmPings).toBe(3);
    expect(saved.departPings).toBe(4);
    expect(saved.scheduleArmGraceSeconds).toBe(90);
    expect(saved.terminals[0]!.radiusMeters).toBe(250);
    expect(saved.realtime.apiKey).toBe('sekrit');
  });
});