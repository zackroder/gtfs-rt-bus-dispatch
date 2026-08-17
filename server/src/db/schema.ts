import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// Schema creation is idempotent because the same path is opened on startup and by tests.
// WAL improves concurrent API reads while foreign keys protect operational references.
// Open the database and ensure both static and operational tables exist.
export function createDatabase(dbPath: string): Database.Database {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    /* Static GTFS tables are replaced as a unit when a feed is loaded. */
    CREATE TABLE IF NOT EXISTS stops (
      stop_id TEXT PRIMARY KEY,
      stop_code TEXT,
      stop_name TEXT,
      parent_station TEXT,
      lat REAL,
      lon REAL
    );

    CREATE TABLE IF NOT EXISTS routes (
      route_id TEXT PRIMARY KEY,
      agency_id TEXT,
      short_name TEXT,
      long_name TEXT,
      type INTEGER,
      color TEXT,
      text_color TEXT
    );

    CREATE TABLE IF NOT EXISTS trips (
      trip_id TEXT PRIMARY KEY,
      route_id TEXT,
      service_id TEXT,
      block_id TEXT,
      direction_id INTEGER,
      headsign TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_trips_route ON trips(route_id);
    CREATE INDEX IF NOT EXISTS idx_trips_block ON trips(block_id);

    CREATE TABLE IF NOT EXISTS stop_times (
      trip_id TEXT,
      stop_sequence INTEGER,
      stop_id TEXT,
      arrival_time INTEGER,
      departure_time INTEGER,
      pickup_type INTEGER,
      drop_off_type INTEGER,
      PRIMARY KEY (trip_id, stop_sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_st_trip ON stop_times(trip_id);
    CREATE INDEX IF NOT EXISTS idx_st_stop ON stop_times(stop_id);

    CREATE TABLE IF NOT EXISTS calendar (
      service_id TEXT PRIMARY KEY,
      monday INTEGER, tuesday INTEGER, wednesday INTEGER, thursday INTEGER,
      friday INTEGER, saturday INTEGER, sunday INTEGER,
      start_date TEXT, end_date TEXT
    );

    CREATE TABLE IF NOT EXISTS calendar_dates (
      service_id TEXT,
      date TEXT,
      exception_type INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_cd_date ON calendar_dates(date);

    CREATE TABLE IF NOT EXISTS block_trips (
      block_id TEXT,
      seq INTEGER,
      trip_id TEXT,
      start_time INTEGER,
      route_id TEXT,
      service_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bt_block ON block_trips(block_id);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_json TEXT
    );

    CREATE TABLE IF NOT EXISTS interventions (
      id TEXT PRIMARY KEY,
      service_date TEXT NOT NULL,
      terminal_id TEXT NOT NULL,
      route_id TEXT NOT NULL,
      rule TEXT NOT NULL,
      trip_id TEXT NOT NULL,
      vehicle_id TEXT,
      leader_vehicle_id TEXT,
      follower_vehicle_id TEXT,
      hold_seconds INTEGER NOT NULL,
      reason TEXT NOT NULL,
      until_seconds INTEGER,
      generated_at INTEGER NOT NULL,
      expires_at INTEGER,
      status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'declined', 'canceled', 'expired', 'completed')),
      applied_at INTEGER,
      resolved_at INTEGER,
      UNIQUE (service_date, terminal_id, route_id, trip_id, rule)
    );
    CREATE INDEX IF NOT EXISTS idx_interventions_terminal_date
      ON interventions(terminal_id, service_date, generated_at);
    CREATE INDEX IF NOT EXISTS idx_interventions_status
      ON interventions(status, service_date);

    CREATE TABLE IF NOT EXISTS intervention_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      intervention_id TEXT NOT NULL REFERENCES interventions(id),
      action TEXT NOT NULL CHECK (action IN ('created', 'viewed', 'applied', 'declined', 'canceled', 'expired', 'completed')),
      occurred_at INTEGER NOT NULL,
      actor_id TEXT NOT NULL,
      request_id TEXT,
      metadata_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_intervention_events_intervention
      ON intervention_events(intervention_id, occurred_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_intervention_events_request
      ON intervention_events(intervention_id, action, request_id)
      WHERE request_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS config_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at INTEGER NOT NULL,
      actor_id TEXT NOT NULL,
      request_id TEXT,
      config_json TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_config_events_request
      ON config_events(occurred_at, request_id)
      WHERE request_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS run_facts (
      service_date TEXT NOT NULL,
      trip_id TEXT NOT NULL,
      arrival_seconds INTEGER,
      departure_seconds INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (service_date, trip_id)
    );
    CREATE INDEX IF NOT EXISTS idx_run_facts_trip ON run_facts(trip_id);

    /* Append-only audit of observed arrival/departure facts, for debugging and tuning the
       dispatch algorithm. Unlike run_facts (rewritten per observation), this preserves every
       distinct recorded value with the terminal/route context and dispatch state at the time. */
    CREATE TABLE IF NOT EXISTS run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_date TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('arrival', 'departure')),
      trip_id TEXT NOT NULL,
      vehicle_id TEXT,
      terminal_id TEXT,
      route_id TEXT,
      source TEXT NOT NULL CHECK (source IN ('vp', 'tu')),
      value_seconds INTEGER NOT NULL,
      generated_at INTEGER NOT NULL,
      classification TEXT,
      edt_seconds INTEGER,
      scheduled_departure INTEGER,
      scheduled_arrival INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE (service_date, trip_id, event_type, value_seconds)
    );
    CREATE INDEX IF NOT EXISTS idx_run_events_date ON run_events(service_date, generated_at);
    CREATE INDEX IF NOT EXISTS idx_run_events_trip ON run_events(trip_id);
  `);
  // These additive migrations keep databases created by earlier builds usable without
  // destructive recreation, and the backfill supplies service scope to old block rows.
  ensureColumn(db, 'routes', 'color', 'TEXT');
  ensureColumn(db, 'routes', 'text_color', 'TEXT');
  ensureColumn(db, 'block_trips', 'service_id', 'TEXT');
  db.exec(`
    UPDATE block_trips
    SET service_id = (SELECT service_id FROM trips WHERE trips.trip_id = block_trips.trip_id)
    WHERE service_id IS NULL
  `);
  return db;
}

function ensureColumn(db: Database.Database, table: string, column: string, type: string): void {
  // SQLite has no general IF NOT EXISTS form for ADD COLUMN, so inspect table_info first.
  const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
