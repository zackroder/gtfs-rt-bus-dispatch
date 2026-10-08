import fs from 'node:fs';
import type { Database } from 'better-sqlite3';
import { setSetting } from '../config';
import { STATIC_SCHEMA_SQL, STATIC_TABLE_NAMES } from './schema';

// Static markers travel with the baked static tables. `staticLoadedAt` drives the
// newer-than-volume comparison; `serviceDayStartSeconds` is static-derived (detected from
// stop_times) and must move with the schedule or every service-day clock shifts by the
// difference (CTA's is 9600 s vs the 10800 s default). Both are refreshed together.
const STATIC_MARKER_KEYS = ['staticLoadedAt', 'serviceDayStartSeconds'] as const;

// Whether baked mode is serving stale static: the volume has no newer data than the image and
// its static is older than staticRefreshHours (or absent). True means /api/health should report
// `staticStale` and the runtime must not download — it waits for the next scheduled deploy.
export function bakedStaticIsStale(
  copied: boolean,
  volumeLoadedAt: number | null,
  stopCount: number,
  staticRefreshHours: number,
  nowMs: number,
): boolean {
  if (copied) return false;
  // No volume static and no baked refresh is the most stale case (nothing to serve).
  if (stopCount === 0) return true;
  if (volumeLoadedAt === null) return true;
  if (staticRefreshHours <= 0) return false;
  return nowMs - volumeLoadedAt > staticRefreshHours * 3600 * 1000;
}

export interface BakedRefreshResult {
  /** True when the volume's static tables were replaced from the baked file. */
  copied: boolean;
  /** The baked file's staticLoadedAt marker, or null when the file is absent/unreadable. */
  bakedLoadedAt: number | null;
}

// Read one setting from the attached `baked` database, tolerating a missing/malformed row.
function readBakedMarker(volumeDb: Database, key: string): unknown {
  const row = volumeDb.prepare(`SELECT value_json FROM baked.settings WHERE key = ?`).get(key) as
    | { value_json: string }
    | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.value_json);
  } catch {
    return undefined;
  }
}

// Replace the volume DB's static tables from the baked file when the image carries newer data.
// SQL-level INSERT ... SELECT keeps memory near steady state (no JS row materialization); only
// the static tables and the two static markers move, so the volume's appConfig, operational
// tables, and audit logs are untouched. Returns without touching the volume when the baked file
// is missing or not newer. `onCopied` lets the caller run the post-load engine invalidation.
export function refreshStaticFromBaked(
  volumeDb: Database,
  bakedPath: string,
  onCopied?: () => void,
): BakedRefreshResult {
  if (!fs.existsSync(bakedPath)) return { copied: false, bakedLoadedAt: null };

  // ATTACH/DETACH cannot run inside a transaction, so attach first and detach in `finally`.
  volumeDb.prepare(`ATTACH DATABASE ? AS baked`).run(bakedPath);
  try {
    const bakedLoadedAtRaw = readBakedMarker(volumeDb, 'staticLoadedAt');
    const bakedLoadedAt = typeof bakedLoadedAtRaw === 'number' ? bakedLoadedAtRaw : null;
    if (bakedLoadedAt === null) return { copied: false, bakedLoadedAt: null };

    const volumeRow = volumeDb
      .prepare(`SELECT value_json FROM main.settings WHERE key = 'staticLoadedAt'`)
      .get() as { value_json: string } | undefined;
    let volumeLoadedAt: unknown;
    if (volumeRow) {
      try {
        volumeLoadedAt = JSON.parse(volumeRow.value_json);
      } catch {
        volumeLoadedAt = undefined;
      }
    }
    // The volume is authoritative once it is at least as new as the image.
    if (typeof volumeLoadedAt === 'number' && bakedLoadedAt <= volumeLoadedAt) {
      return { copied: false, bakedLoadedAt };
    }

    const copy = volumeDb.transaction(() => {
      for (const table of STATIC_TABLE_NAMES) {
        volumeDb.exec(`DROP TABLE IF EXISTS main.${table}`);
      }
      // Recreate the exact schema (tables + indexes) before bulk-filling from the baked file.
      volumeDb.exec(STATIC_SCHEMA_SQL);
      for (const table of STATIC_TABLE_NAMES) {
        volumeDb.exec(`INSERT INTO main.${table} SELECT * FROM baked.${table}`);
      }
      for (const key of STATIC_MARKER_KEYS) {
        const value = readBakedMarker(volumeDb, key);
        if (value !== undefined) setSetting(volumeDb, key, value);
      }
    });
    copy();
    onCopied?.();
    return { copied: true, bakedLoadedAt };
  } finally {
    volumeDb.exec(`DETACH DATABASE baked`);
  }
}
