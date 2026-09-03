import type { Database } from 'better-sqlite3';

// GTFS permits service times beyond 24:00. The application stores them relative to a
// detected service-day boundary so overnight trips sort in operational order.
export const SECONDS_PER_DAY = 86400;
export const DEFAULT_SERVICE_DAY_START = 3 * 3600;
export const DEFAULT_AGENCY_TIMEZONE = 'America/Chicago';

// Parse a GTFS clock value without applying a service-day offset.
export function parseGtfsTime(value: string): number | null {
  const match = /^(\d{1,2}):(\d{1,2}):(\d{1,2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (minutes > 59 || seconds > 59) return null;
  // Do not modulo here: values such as 25:30:00 must remain distinguishable until
  // normalizeServiceSeconds applies the service-day origin.
  return hours * 3600 + minutes * 60 + seconds;
}

export interface TripSpan {
  startRaw: number;
  endRaw: number;
}

function markRange(buckets: number[], fromSec: number, toSec: number): void {
  const from = Math.floor(fromSec / 60);
  const to = Math.floor(toSec / 60);
  for (let m = from; m <= to && m < 1440; m++) buckets[m]! += 1;
}

// Find the least-covered overnight lull and use the minute after it as the service boundary.
export function detectServiceDayStart(spans: TripSpan[]): number {
  if (spans.length === 0) return DEFAULT_SERVICE_DAY_START;
  const buckets = new Array<number>(1440).fill(0);
  for (const span of spans) {
    // Reduce each trip to wall-clock minutes and split spans that cross midnight.
    const start = span.startRaw % SECONDS_PER_DAY;
    const end = span.endRaw % SECONDS_PER_DAY;
    if (end <= start) {
      markRange(buckets, start, SECONDS_PER_DAY - 1);
      markRange(buckets, 0, end);
    } else {
      markRange(buckets, start, end - 1);
    }
  }
  const zeroMinutes = buckets.filter((c) => c === 0).length;
  if (zeroMinutes === 0) {
    // With no uncovered minute there is no unique lull, so use the stable default unless
    // exactly one least-covered minute identifies a boundary.
    const min = Math.min(...buckets);
    const least: number[] = [];
    buckets.forEach((count, minute) => {
      if (count === min) least.push(minute);
    });
    if (least.length === 1) return ((least[0]! + 1) % 1440) * 60;
    return DEFAULT_SERVICE_DAY_START;
  }
  let bestStart = 0;
  let bestLen = 0;
  let runStart = -1;
  for (let i = 0; i < 1440 * 2; i++) {
    // Scan two days so an overnight zero-run can be treated as one circular interval.
    const idx = i % 1440;
    if (buckets[idx] === 0) {
      if (runStart === -1) runStart = i;
      const len = i - runStart + 1;
      if (len > bestLen && len <= 1440) {
        bestLen = len;
        bestStart = runStart % 1440;
      }
    } else {
      runStart = -1;
    }
  }
  return ((bestStart + bestLen) % 1440) * 60;
}

// Convert raw GTFS seconds to a clock relative to the configured service-day origin.
export function normalizeServiceSeconds(raw: number, serviceDayStartSeconds: number): number {
  // The double modulo keeps the result in [0, 86400) even when raw is before the origin.
  const diff = raw - serviceDayStartSeconds;
  return ((diff % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
}

// GTFS schedule times are agency-local wall clocks. Evaluating them through the server's own
// local Date getters silently shifts the whole schedule when the process runs in another zone
// (a UTC cloud host vs. Chicago operations), so every "now" conversion below takes the agency
// timezone explicitly and resolves civil time through Intl.

// Offset memoization: Intl formatting is far too slow to run per vehicle position, and DST
// transitions land on UTC hour boundaries, so a per-(timezone, UTC hour) bucket never straddles
// a transition and one offset serves every timestamp within that hour.
const offsetCache = new Map<string, number>();

// Offset (seconds) to add to an epoch instant to obtain wall-clock time in the zone.
export function timeZoneOffsetSeconds(date: Date, timeZone: string): number {
  const key = `${timeZone}|${Math.floor(date.getTime() / 3_600_000)}`;
  let offset = offsetCache.get(key);
  if (offset === undefined) {
    const parts = new Map(
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
        .formatToParts(date)
        .map((part) => [part.type, part.value] as const),
    );
    const asUtc = Date.UTC(
      Number(parts.get('year')),
      Number(parts.get('month')) - 1,
      Number(parts.get('day')),
      Number(parts.get('hour')),
      Number(parts.get('minute')),
      Number(parts.get('second')),
    ) / 1000;
    offset = asUtc - Math.floor(date.getTime() / 1000);
    offsetCache.set(key, offset);
  }
  return offset;
}

// Wall-clock seconds since midnight in the agency timezone.
export function zoneSecondsSinceMidnight(date: Date, timeZone: string): number {
  const shifted = Math.floor(date.getTime() / 1000) + timeZoneOffsetSeconds(date, timeZone);
  return ((shifted % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
}

// Convert the current agency wall clock to the normalized service-day clock.
export function nowServiceSeconds(now: Date, serviceDayStartSeconds: number, timeZone: string): number {
  return normalizeServiceSeconds(zoneSecondsSinceMidnight(now, timeZone), serviceDayStartSeconds);
}

// Convert an epoch timestamp through the agency timezone into service-day seconds.
export function unixToServiceSeconds(unix: number, serviceDayStartSeconds: number, timeZone: string): number {
  return nowServiceSeconds(new Date(unix * 1000), serviceDayStartSeconds, timeZone);
}

// Format the calendar date that owns the current service-day segment, in the agency timezone.
export function activeServiceDate(now: Date, serviceDayStartSeconds: number, timeZone: string): string {
  const zoneNow = new Date(now.getTime() + timeZoneOffsetSeconds(now, timeZone) * 1000);
  // After midnight but before the service boundary still belongs to yesterday's service date.
  // setUTCDate rolls across month/year boundaries the same way the previous local code did.
  if (zoneSecondsSinceMidnight(now, timeZone) < serviceDayStartSeconds) {
    zoneNow.setUTCDate(zoneNow.getUTCDate() - 1);
  }
  // Reading the offset-shifted instant through UTC getters yields the zone's civil calendar.
  const y = zoneNow.getUTCFullYear();
  const m = String(zoneNow.getUTCMonth() + 1).padStart(2, '0');
  const d = String(zoneNow.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

// Resolve recurring calendar service and date exceptions for one service date.
export function activeServiceIds(db: Database, dateKey: string): Set<string> {
  const year = Number(dateKey.slice(0, 4));
  const month = Number(dateKey.slice(4, 6));
  const day = Number(dateKey.slice(6, 8));
  const weekday = new Date(year, month - 1, day).getDay();
  const weekdayColumn = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][weekday];
  const active = new Set<string>();
  // Calendar supplies the recurring services; calendar_dates then adds and removes exceptions.
  const calendarRows = db
    .prepare(
      `SELECT service_id, ${weekdayColumn} AS flag FROM calendar WHERE start_date <= ? AND end_date >= ?`,
    )
    .all(dateKey, dateKey) as Array<{ service_id: string; flag: number }>;
  for (const row of calendarRows) {
    if (row.flag === 1) active.add(row.service_id);
  }
  const added = db
    .prepare(`SELECT service_id FROM calendar_dates WHERE date = ? AND exception_type = 1`)
    .all(dateKey) as Array<{ service_id: string }>;
  for (const row of added) active.add(row.service_id);
  const removed = db
    .prepare(`SELECT service_id FROM calendar_dates WHERE date = ? AND exception_type = 2`)
    .all(dateKey) as Array<{ service_id: string }>;
  for (const row of removed) active.delete(row.service_id);
  return active;
}

// Read the detected static-feed service boundary, falling back for an uninitialized database.
export function getServiceDayStart(db: Database): number {
  const row = db
    .prepare(`SELECT value_json FROM settings WHERE key = 'serviceDayStartSeconds'`)
    .get() as { value_json: string } | undefined;
  if (!row) return DEFAULT_SERVICE_DAY_START;
  // Settings are JSON because the same table stores the complete application configuration.
  const parsed: unknown = JSON.parse(row.value_json);
  return typeof parsed === 'number' ? parsed : DEFAULT_SERVICE_DAY_START;
}

// Read the static feed load timestamp used by startup staleness checks.
export function getStaticLoadedAt(db: Database): number | null {
  const row = db
    .prepare(`SELECT value_json FROM settings WHERE key = 'staticLoadedAt'`)
    .get() as { value_json: string } | undefined;
  if (!row) return null;
  const parsed: unknown = JSON.parse(row.value_json);
  return typeof parsed === 'number' ? parsed : null;
}
