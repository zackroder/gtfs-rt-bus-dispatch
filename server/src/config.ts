import type { Database } from 'better-sqlite3';
import { appConfigSchema, type AppConfig } from '../../shared/types';

// Settings are stored as JSON so the runtime configuration can evolve as one validated object.
// Return the raw JSON so callers can distinguish a missing key from a stored falsey value.
export function getSetting(db: Database, key: string): string | null {
  const row = db.prepare(`SELECT value_json FROM settings WHERE key = ?`).get(key) as
    | { value_json: string }
    | undefined;
  return row ? row.value_json : null;
}

// Upsert one JSON-encoded runtime setting without requiring callers to manage SQL conflict syntax.
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

// Geometry-detection defaults, applied when a saved or env-derived config omits them
// so an older persisted config transparently gains the new keys after a reload.
export const GEOMETRY_DEFAULTS = {
  arrivalRadiusMeters: 150,
  terminalMovementMeters: 75,
  stationaryDisplacementMeters: 20,
  confirmPings: 2,
  departPings: 2,
  scheduleArmGraceSeconds: 120,
  vehiclePositionMaxAgeSeconds: 300,
  departureTriggerMeters: 75,
} as const;

// Fill missing geometry settings from defaults; keeps schema-optional fields present at runtime.
function withGeometryDefaults(config: AppConfig): AppConfig {
  return {
    ...config,
    arrivalRadiusMeters: config.arrivalRadiusMeters ?? GEOMETRY_DEFAULTS.arrivalRadiusMeters,
    terminalMovementMeters: config.terminalMovementMeters ?? GEOMETRY_DEFAULTS.terminalMovementMeters,
    stationaryDisplacementMeters:
      config.stationaryDisplacementMeters ?? GEOMETRY_DEFAULTS.stationaryDisplacementMeters,
    confirmPings: config.confirmPings ?? GEOMETRY_DEFAULTS.confirmPings,
    departPings: config.departPings ?? GEOMETRY_DEFAULTS.departPings,
    scheduleArmGraceSeconds:
      config.scheduleArmGraceSeconds ?? GEOMETRY_DEFAULTS.scheduleArmGraceSeconds,
    vehiclePositionMaxAgeSeconds:
      config.vehiclePositionMaxAgeSeconds ?? GEOMETRY_DEFAULTS.vehiclePositionMaxAgeSeconds,
    departureTriggerMeters: config.departureTriggerMeters ?? GEOMETRY_DEFAULTS.departureTriggerMeters,
  };
}

// Environment variables provide first-run defaults; persisted settings take precedence afterward.
function defaultsFromEnv(env: NodeJS.ProcessEnv): AppConfig {
  const config: AppConfig = {
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
  return withGeometryDefaults(config);
}

export function loadConfig(db: Database, env: NodeJS.ProcessEnv): AppConfig {
  const saved = getSetting(db, 'appConfig');
  if (saved === null) {
    // Parse before persisting so the database never receives an invalid initial configuration.
    const config = appConfigSchema.parse(defaultsFromEnv(env));
    setSetting(db, 'appConfig', config);
    return config;
  }
  const parsed: unknown = JSON.parse(saved);
  const config = appConfigSchema.parse(withGeometryDefaults(parsed as AppConfig));
  let mutated = false;
  // Secrets and newly introduced feed settings may still be supplied by the environment
  // without overwriting the operator's other persisted choices.
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

// Validate and persist a complete replacement while retaining the existing secret when omitted.
export function applyConfig(db: Database, current: AppConfig, next: AppConfig): AppConfig {
  // An omitted API key means "keep the existing secret", not "clear the secret".
  const merged: AppConfig = {
    ...next,
    realtime: {
      ...next.realtime,
      apiKey: next.realtime.apiKey || current.realtime.apiKey,
    },
  };
  const validated = appConfigSchema.parse(withGeometryDefaults(merged));
  setSetting(db, 'appConfig', validated);
  return validated;
}

// Return a copy safe for API responses and logs by removing the realtime credential.
export function redactConfig(config: AppConfig): AppConfig {
  const redacted: AppConfig = { ...config, realtime: { ...config.realtime } };
  delete redacted.realtime.apiKey;
  return redacted;
}

// Append a redacted configuration snapshot for operational accountability.
export function recordConfigEvent(
  db: Database,
  config: AppConfig,
  actorId: string,
  requestId?: string,
): void {
  // Audit records deliberately contain the redacted configuration, never the API key.
  db.prepare(
    `INSERT OR IGNORE INTO config_events (occurred_at, actor_id, request_id, config_json)
     VALUES (?, ?, ?, ?)`,
  ).run(Math.floor(Date.now() / 1000), actorId, requestId ?? null, JSON.stringify(redactConfig(config)));
}
