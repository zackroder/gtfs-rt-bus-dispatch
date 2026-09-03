import { describe, expect, it } from 'vitest';
import {
  activeServiceDate,
  activeServiceIds,
  detectServiceDayStart,
  normalizeServiceSeconds,
  nowServiceSeconds,
  parseGtfsTime,
  unixToServiceSeconds,
  zoneSecondsSinceMidnight,
} from './time';
import { createDatabase } from '../db/schema';

// Time tests pin the service-day clock independently from timezone/date-sensitive engine
// behavior. Every instant is built from an explicit UTC offset string and every conversion is
// given an explicit IANA zone, so the suite passes identically on a Chicago workstation and a
// UTC CI host.
const CHICAGO = 'America/Chicago';
const UTC = 'UTC';
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
  // Synthetic spans cover normal, overnight, uniform, and empty schedule shapes.
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
    // 01:00 CDT (August, UTC-5) == 06:00Z.
    const now = new Date('2026-08-13T06:00:00Z');
    expect(nowServiceSeconds(now, 5 * 3600, CHICAGO)).toBe(20 * 3600);
  });

  it('uses plain agency seconds during the day', () => {
    const now = new Date('2026-08-13T15:15:00Z');
    expect(nowServiceSeconds(now, 5 * 3600, CHICAGO)).toBe(5 * 3600 + 15 * 60);
  });
});

describe('unixToServiceSeconds', () => {
  it('converts a unix timestamp to service-day seconds in the agency zone', () => {
    const unix = new Date('2026-08-13T15:15:00Z').getTime() / 1000;
    expect(unixToServiceSeconds(unix, 5 * 3600, CHICAGO)).toBe(5 * 3600 + 15 * 60);
  });
});

describe('activeServiceDate', () => {
  it('uses the previous calendar day before the service-day start', () => {
    const now = new Date('2026-08-13T06:00:00Z'); // 01:00 CDT
    expect(activeServiceDate(now, 5 * 3600, CHICAGO)).toBe('20260812');
  });

  it('uses today once the service day has started', () => {
    const now = new Date('2026-08-13T11:00:00Z'); // 06:00 CDT
    expect(activeServiceDate(now, 5 * 3600, CHICAGO)).toBe('20260813');
  });

  it('rolls across month boundaries when stepping back a day', () => {
    const now = new Date('2026-09-01T06:00:00Z'); // 01:00 CDT on Sep 1 -> belongs to Aug 31
    expect(activeServiceDate(now, 5 * 3600, CHICAGO)).toBe('20260831');
  });
});

describe('activeServiceIds', () => {
  // These cases verify recurring calendar rows and date exceptions are combined in the documented order.
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

describe('zoneSecondsSinceMidnight', () => {
  it('computes wall-clock seconds in the requested zone', () => {
    expect(zoneSecondsSinceMidnight(new Date('2026-01-01T00:00:00Z'), UTC)).toBe(0);
    expect(zoneSecondsSinceMidnight(new Date('2026-01-01T01:02:03Z'), UTC)).toBe(3723);
  });

  it('applies the zone offset, not the host clock', () => {
    // 12:00Z is noon in UTC but 07:00 CDT; the host's local zone must not matter.
    const instant = new Date('2026-08-13T12:00:00Z');
    expect(zoneSecondsSinceMidnight(instant, UTC)).toBe(12 * 3600);
    expect(zoneSecondsSinceMidnight(instant, CHICAGO)).toBe(7 * 3600);
  });

  it('handles the fall-back DST transition within one hour bucket', () => {
    // 2026-11-01 07:00Z: 01:59:59 CDT is followed by 01:00 CST, so wall time jumps backward.
    expect(zoneSecondsSinceMidnight(new Date('2026-11-01T06:59:59Z'), CHICAGO)).toBe(7199);
    expect(zoneSecondsSinceMidnight(new Date('2026-11-01T07:00:00Z'), CHICAGO)).toBe(3600);
  });

  it('handles the spring-forward DST transition within one hour bucket', () => {
    // 2026-03-08 08:00Z: 01:59:59 CST is followed by 03:00:00 CDT; 02:xx does not exist.
    expect(zoneSecondsSinceMidnight(new Date('2026-03-08T07:59:59Z'), CHICAGO)).toBe(7199);
    expect(zoneSecondsSinceMidnight(new Date('2026-03-08T08:00:00Z'), CHICAGO)).toBe(3 * 3600);
  });
});
