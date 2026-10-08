import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase } from './schema';
import { loadStatic } from './staticLoader';
import { getSetting, setSetting } from '../config';
import { bakedStaticIsStale, refreshStaticFromBaked } from './bakedStatic';
import { syntheticGtfs } from '../test/fixtures';

// A tiny static fixture with `stopIds.length` stops so the copy's row counts are easy to assert.
function staticFixture(stopIds: string[]) {
  return syntheticGtfs({
    stops: stopIds.map((id) => ({ stopId: id, name: id })),
    trips: [
      {
        tripId: 'T1',
        stopTimes: stopIds.map((id, i) => ({
          stopId: id,
          arr: `08:${String(i * 5).padStart(2, '0')}:00`,
          dep: `08:${String(i * 5).padStart(2, '0')}:00`,
        })),
      },
    ],
  });
}

function marker(db: ReturnType<typeof createDatabase>, key: string): unknown {
  const raw = getSetting(db, key);
  return raw === null ? undefined : JSON.parse(raw);
}

function count(db: ReturnType<typeof createDatabase>, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

describe('refreshStaticFromBaked', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('copies static tables + markers when the baked file is newer, leaving volume config/logs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baked-static-'));
    const bakedPath = path.join(dir, 'baked.db');
    const volumePath = path.join(dir, 'volume.db');
    try {
      const baked = createDatabase(bakedPath);
      loadStatic(baked, staticFixture(['A', 'B', 'C']));
      setSetting(baked, 'staticLoadedAt', 2000);
      const bakedStart = marker(baked, 'serviceDayStartSeconds');
      baked.close();

      const volume = createDatabase(volumePath);
      loadStatic(volume, staticFixture(['T', 'B']));
      setSetting(volume, 'staticLoadedAt', 1000);
      setSetting(volume, 'appConfig', { marker: 'keep-me' });
      volume
        .prepare(
          `INSERT INTO interventions
             (id, service_date, terminal_id, route_id, rule, trip_id, hold_seconds, reason, generated_at, status)
           VALUES ('i1', '20260813', 'T', '1', 'hold', 'D1', 60, 'x', 1, 'pending')`,
        )
        .run();

      const onCopied = vi.fn();
      const result = refreshStaticFromBaked(volume, bakedPath, onCopied);

      expect(result).toEqual({ copied: true, bakedLoadedAt: 2000 });
      expect(onCopied).toHaveBeenCalledTimes(1);
      // Static tables replaced from the baked file.
      expect(count(volume, 'stops')).toBe(3);
      expect(count(volume, 'stop_times')).toBe(3);
      // Static markers moved with the schedule (serviceDayStartSeconds must not stay stale).
      expect(marker(volume, 'staticLoadedAt')).toBe(2000);
      expect(marker(volume, 'serviceDayStartSeconds')).toBe(bakedStart);
      // Volume-owned config and operational data are untouched.
      expect(marker(volume, 'appConfig')).toEqual({ marker: 'keep-me' });
      expect(count(volume, 'interventions')).toBe(1);
      volume.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a no-op when the volume is at least as new as the baked file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baked-static-'));
    const bakedPath = path.join(dir, 'baked.db');
    const volumePath = path.join(dir, 'volume.db');
    try {
      const baked = createDatabase(bakedPath);
      loadStatic(baked, staticFixture(['A', 'B', 'C']));
      setSetting(baked, 'staticLoadedAt', 2000);
      baked.close();

      const volume = createDatabase(volumePath);
      loadStatic(volume, staticFixture(['T', 'B']));
      setSetting(volume, 'staticLoadedAt', 3000);

      const onCopied = vi.fn();
      const result = refreshStaticFromBaked(volume, bakedPath, onCopied);
      expect(result).toEqual({ copied: false, bakedLoadedAt: 2000 });
      expect(onCopied).not.toHaveBeenCalled();
      expect(count(volume, 'stops')).toBe(2);
      expect(marker(volume, 'staticLoadedAt')).toBe(3000);
      volume.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports no copy when the baked file is absent, and never downloads', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baked-static-'));
    const volumePath = path.join(dir, 'volume.db');
    try {
      const volume = createDatabase(volumePath);
      loadStatic(volume, staticFixture(['T', 'B']));
      // A stale volume with no baked image: the caller surfaces staticStale and must not fetch.
      setSetting(volume, 'staticLoadedAt', 1);
      const fetchMock = vi.fn(async () => {
        throw new Error('baked mode must not download');
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = refreshStaticFromBaked(volume, path.join(dir, 'missing.db'));
      expect(result).toEqual({ copied: false, bakedLoadedAt: null });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(
        bakedStaticIsStale(result.copied, 1, count(volume, 'stops'), 24, Date.now()),
      ).toBe(true);
      volume.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
