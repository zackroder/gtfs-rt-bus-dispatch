import type { Database } from 'better-sqlite3';
import { appConfigSchema, type AppConfig } from '../../shared/types';

export function getSetting(db: Database, key: string): string | null {
  const row = db.prepare(`SELECT value_json FROM settings WHERE key = ?`).get(key) as
    | { value_json: string }
    | undefined;
  return row ? row.value_json : null;
}

export function setSetting(db: Database, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
  ).run(key, JSON.stringify(value));
}

const DEFAULT_URLS = {
  tripUpdatesUrl: 'https://transitdata.transitchicago.com/GtfsRealtime/TripUpdates.pb',
  vehiclePositionsUrl: 'https://transitdata.transitchicago.com/GtfsRealtime/VehiclePositions.pb',
  staticGtfsUrl: 'https://www.transitchicago.com/downloads/sch_data/google_transit.zip',
};

function defaultsFromEnv(env: NodeJS.ProcessEnv): AppConfig {
  return {
    realtime: {
      tripUpdatesUrl: env.CTA_TU_URL ?? DEFAULT_URLS.tripUpdatesUrl,
      vehiclePositionsUrl: env.CTA_VP_URL ?? DEFAULT_URLS.vehiclePositionsUrl,
      apiKey: env.CTA_API_KEY || undefined,
    },
    staticGtfsUrl: env.CTA_STATIC_URL ?? DEFAULT_URLS.staticGtfsUrl,
    refreshIntervalSeconds: 10,
    staticRefreshHours: 24,
    minRestMinutes: 5,
    maxHoldMinutes: 10,
    leadTimeMinutes: 5,
    lookaheadMinutes: 90,
    terminals: [],
  };
}

export function loadConfig(db: Database, env: NodeJS.ProcessEnv): AppConfig {
  const saved = getSetting(db, 'appConfig');
  if (saved === null) {
    const config = appConfigSchema.parse(defaultsFromEnv(env));
    setSetting(db, 'appConfig', config);
    return config;
  }
  const parsed: unknown = JSON.parse(saved);
  const config = appConfigSchema.parse(parsed);
  let mutated = false;
  if (!config.realtime.apiKey && env.CTA_API_KEY) {
    config.realtime.apiKey = env.CTA_API_KEY;
    mutated = true;
  }
  if (!config.realtime.vehiclePositionsUrl) {
    config.realtime.vehiclePositionsUrl = env.CTA_VP_URL ?? DEFAULT_URLS.vehiclePositionsUrl;
    mutated = true;
  }
  if (mutated) setSetting(db, 'appConfig', config);
  return config;
}

export function applyConfig(db: Database, current: AppConfig, next: AppConfig): AppConfig {
  const merged: AppConfig = {
    ...next,
    realtime: {
      ...next.realtime,
      apiKey: next.realtime.apiKey || current.realtime.apiKey,
    },
  };
  const validated = appConfigSchema.parse(merged);
  setSetting(db, 'appConfig', validated);
  return validated;
}

export function redactConfig(config: AppConfig): AppConfig {
  const redacted: AppConfig = { ...config, realtime: { ...config.realtime } };
  delete redacted.realtime.apiKey;
  return redacted;
}
