import { describe, expect, it } from 'vitest';
import {
  activeServiceDate,
  activeServiceIds,
  detectServiceDayStart,
  localSecondsSinceMidnight,
  normalizeServiceSeconds,
  nowServiceSeconds,
  parseGtfsTime,
  unixToServiceSeconds,
} from './time';
import { createDatabase } from '../db/schema';

describe('parseGtfsTime', () => {
  it('parses normal times', () => {
    expect(parseGtfsTime('05:30:00')).toBe(5 * 3600 + 30 * 60);
    expect(parseGtfsTime('00:00:00')).toBe(0);
  });

  it('parses after-midnight 24:00:00+ times', () => {
    expect(parseGtfsTime('24:00:00')).toBe(86400);
    expect(parseGtfsTime('25:30:00')).toBe(25 * 3600 + 30 * 60);
    expect(parseGtfsTime('30:15:00')).toBe(30 * 3600 + 15 * 60);
  });

  it('rejects invalid times', () => {
    expect(parseGtfsTime('10:99:00')).toBeNull();
    expect(parseGtfsTime('banana')).toBeNull();
    expect(parseGtfsTime('')).toBeNull();
  });
});

describe('detectServiceDayStart', () => {
  it('finds the largest overnight lull and returns the first minute after it', () => {
    const spans = [
      { startRaw: 5 * 3600, endRaw: 21 * 3600 },
      { startRaw: 5 * 3600 + 1800, endRaw: 22 * 3600 },
      { startRaw: 21 * 3600 + 3600, endRaw: 23 * 3600 + 1800 },
    ];
    expect(detectServiceDayStart(spans)).toBe(5 * 3600);
  });

  it('handles trips crossing midnight', () => {
    const spans = [
      { startRaw: 22 * 3600, endRaw: 26 * 3600 },
      { startRaw: 23 * 3600, endRaw: 27 * 3600 },
    ];
    expect(detectServiceDayStart(spans)).toBe(22 * 3600);
  });

  it('falls back to 03:00 when coverage is uniform', () => {
    const spans: Array<{ startRaw: number; endRaw: number }> = [];
    for (let h = 0; h < 24; h += 6) {
      spans.push({ startRaw: h * 3600, endRaw: (h + 6) * 3600 });
    }
    expect(detectServiceDayStart(spans)).toBe(3 * 3600);
  });

  it('falls back to 03:00 when there are no trips', () => {
    expect(detectServiceDayStart([])).toBe(3 * 3600);
  });
});

describe('normalizeServiceSeconds', () => {
  it('shifts times by the service-day start', () => {
    expect(normalizeServiceSeconds(5 * 3600, 5 * 3600)).toBe(0);
    expect(normalizeServiceSeconds(10 * 3600, 5 * 3600)).toBe(5 * 3600);
  });

  it('wraps after-midnight times into the same service day', () => {
    expect(normalizeServiceSeconds(25 * 3600 + 30 * 60, 5 * 3600)).toBe(20 * 3600 + 30 * 60);
  });
});

describe('nowServiceSeconds', () => {
  it('wraps shortly after midnight to late service-day seconds', () => {
    const now = new Date(2026, 7, 13, 1, 0, 0);
    expect(nowServiceSeconds(now, 5 * 3600)).toBe(20 * 3600);
  });

  it('uses plain local seconds during the day', () => {
    const now = new Date(2026, 7, 13, 10, 15, 0);
    expect(nowServiceSeconds(now, 5 * 3600)).toBe(5 * 3600 + 15 * 60);
  });
});

describe('unixToServiceSeconds', () => {
  it('converts a unix timestamp to service-day seconds', () => {
    const unix = new Date(2026, 7, 13, 10, 15, 0).getTime() / 1000;
    expect(unixToServiceSeconds(unix, 5 * 3600)).toBe(5 * 3600 + 15 * 60);
  });
});

describe('activeServiceDate', () => {
  it('uses the previous calendar day before the service-day start', () => {
    const now = new Date(2026, 7, 13, 1, 0, 0);
    expect(activeServiceDate(now, 5 * 3600)).toBe('20260812');
  });

  it('uses today once the service day has started', () => {
    const now = new Date(2026, 7, 13, 6, 0, 0);
    expect(activeServiceDate(now, 5 * 3600)).toBe('20260813');
  });
});

describe('activeServiceIds', () => {
  it('unions calendar weekday service and calendar_dates, minus removals', () => {
    const db = createDatabase(':memory:');
    db.exec(`
      INSERT INTO calendar VALUES ('weekday',1,1,1,1,1,0,0,'20260801','20260831');
      INSERT INTO calendar VALUES ('sunday',0,0,0,0,0,0,1,'20260801','20260831');
      INSERT INTO calendar VALUES ('outofrange',1,1,1,1,1,0,0,'20260101','20260131');
      INSERT INTO calendar_dates VALUES ('weekday','20260813',2);
      INSERT INTO calendar_dates VALUES ('holiday','20260813',1);
    `);
    const active = activeServiceIds(db, '20260813');
    expect(active.has('weekday')).toBe(false);
    expect(active.has('sunday')).toBe(false);
    expect(active.has('outofrange')).toBe(false);
    expect(active.has('holiday')).toBe(true);
  });

  it('selects the weekday flag matching the date', () => {
    const db = createDatabase(':memory:');
    db.exec(`
      INSERT INTO calendar VALUES ('sunday',0,0,0,0,0,0,1,'20260801','20260831');
    `);
    expect(activeServiceIds(db, '20260809').has('sunday')).toBe(true);
    expect(activeServiceIds(db, '20260813').has('sunday')).toBe(false);
  });
});

describe('localSecondsSinceMidnight', () => {
  it('computes wall-clock seconds', () => {
    expect(localSecondsSinceMidnight(new Date(2026, 0, 1, 0, 0, 0))).toBe(0);
    expect(localSecondsSinceMidnight(new Date(2026, 0, 1, 1, 2, 3))).toBe(3723);
  });
});
