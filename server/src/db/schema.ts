import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export function createDatabase(dbPath: string): Database.Database {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
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
      route_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bt_block ON block_trips(block_id);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_json TEXT
    );
  `);
  ensureColumn(db, 'routes', 'color', 'TEXT');
  ensureColumn(db, 'routes', 'text_color', 'TEXT');
  return db;
}

function ensureColumn(db: Database.Database, table: string, column: string, type: string): void {
  const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
