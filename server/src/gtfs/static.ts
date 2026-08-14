import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { parse } from 'csv-parse/sync';
import type {
  ParsedCalendar,
  ParsedCalendarDate,
  ParsedRoute,
  ParsedStaticGtfs,
  ParsedStop,
  ParsedStopTime,
  ParsedTrip,
  StaticProvider,
} from '../providers/types';
import { detectServiceDayStart, parseGtfsTime } from './time';

export interface GtfsStaticOptions {
  url: string;
  cachePath?: string;
  force?: boolean;
}

function isZip(buffer: Buffer): boolean {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07)
  );
}

async function fetchZip(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GTFS static download failed: ${res.status} ${res.statusText}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!isZip(buffer)) {
    throw new Error(
      `GTFS static download did not return a zip file (${buffer.length} bytes received); ` +
        `check the URL or place a valid zip at the cache path`,
    );
  }
  return buffer;
}

export async function downloadStatic(url: string, cachePath?: string): Promise<Buffer> {
  if (cachePath && fs.existsSync(cachePath)) {
    const cached = fs.readFileSync(cachePath);
    if (isZip(cached)) return cached;
    fs.unlinkSync(cachePath);
  }
  const buffer = await fetchZip(url);
  if (cachePath) {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, buffer);
  }
  return buffer;
}

function readCsv(zip: AdmZip, name: string): Array<Record<string, string>> {
  const entry = zip.getEntry(name);
  if (!entry) return [];
  const text = entry.getData().toString('utf8');
  if (!text.trim()) return [];
  return parse(text, { columns: true, skip_empty_lines: true, trim: true }) as Array<Record<string, string>>;
}

function pick(row: Record<string, string>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function parseStatic(buffer: Buffer): ParsedStaticGtfs {
  const zip = new AdmZip(buffer);

  const stops: ParsedStop[] = readCsv(zip, 'stops.txt').map((row) => ({
    stopId: pick(row, 'stop_id') ?? '',
    stopCode: pick(row, 'stop_code'),
    stopName: pick(row, 'stop_name') ?? '',
    parentStation: pick(row, 'parent_station'),
    lat: toNumber(pick(row, 'stop_lat')) ?? 0,
    lon: toNumber(pick(row, 'stop_lon')) ?? 0,
  }));

  const routes: ParsedRoute[] = readCsv(zip, 'routes.txt').map((row) => ({
    routeId: pick(row, 'route_id') ?? '',
    agencyId: pick(row, 'agency_id'),
    shortName: pick(row, 'route_short_name') ?? '',
    longName: pick(row, 'route_long_name') ?? '',
    type: toNumber(pick(row, 'route_type')) ?? 0,
    color: pick(row, 'route_color'),
    textColor: pick(row, 'route_text_color'),
  }));

  const trips: ParsedTrip[] = readCsv(zip, 'trips.txt').map((row) => ({
    tripId: pick(row, 'trip_id') ?? '',
    routeId: pick(row, 'route_id') ?? '',
    serviceId: pick(row, 'service_id') ?? '',
    blockId: pick(row, 'block_id'),
    directionId: toNumber(pick(row, 'direction_id')),
    headsign: pick(row, 'trip_headsign'),
  }));

  const stopTimes: ParsedStopTime[] = [];
  for (const row of readCsv(zip, 'stop_times.txt')) {
    const arrivalRaw = pick(row, 'arrival_time');
    const departureRaw = pick(row, 'departure_time');
    const arrival = arrivalRaw !== undefined ? parseGtfsTime(arrivalRaw) : null;
    const departure = departureRaw !== undefined ? parseGtfsTime(departureRaw) : null;
    if (arrival === null && departure === null) continue;
    const tripId = pick(row, 'trip_id');
    const stopId = pick(row, 'stop_id');
    const stopSequence = toNumber(pick(row, 'stop_sequence'));
    if (tripId === undefined || stopId === undefined || stopSequence === undefined) continue;
    stopTimes.push({
      tripId,
      stopSequence,
      stopId,
      arrivalTime: arrival ?? departure ?? 0,
      departureTime: departure ?? arrival ?? 0,
      pickupType: toNumber(pick(row, 'pickup_type')),
      dropOffType: toNumber(pick(row, 'drop_off_type')),
    });
  }

  const spanByTrip = new Map<string, { start: number; end: number }>();
  for (const st of stopTimes) {
    const current = spanByTrip.get(st.tripId);
    if (!current) {
      spanByTrip.set(st.tripId, { start: st.departureTime, end: st.arrivalTime });
    } else {
      current.start = Math.min(current.start, st.departureTime);
      current.end = Math.max(current.end, st.arrivalTime);
    }
  }
  const serviceDayStartSeconds = detectServiceDayStart(
    Array.from(spanByTrip.values(), (span) => ({ startRaw: span.start, endRaw: span.end })),
  );

  const calendar: ParsedCalendar[] = readCsv(zip, 'calendar.txt')
    .map((row) => ({
      serviceId: pick(row, 'service_id') ?? '',
      monday: toNumber(pick(row, 'monday')) ?? 0,
      tuesday: toNumber(pick(row, 'tuesday')) ?? 0,
      wednesday: toNumber(pick(row, 'wednesday')) ?? 0,
      thursday: toNumber(pick(row, 'thursday')) ?? 0,
      friday: toNumber(pick(row, 'friday')) ?? 0,
      saturday: toNumber(pick(row, 'saturday')) ?? 0,
      sunday: toNumber(pick(row, 'sunday')) ?? 0,
      startDate: pick(row, 'start_date') ?? '',
      endDate: pick(row, 'end_date') ?? '',
    }))
    .filter((c) => c.serviceId !== '');

  const calendarDates: ParsedCalendarDate[] = readCsv(zip, 'calendar_dates.txt')
    .map((row) => ({
      serviceId: pick(row, 'service_id') ?? '',
      date: pick(row, 'date') ?? '',
      exceptionType: toNumber(pick(row, 'exception_type')) ?? 0,
    }))
    .filter((c) => c.serviceId !== '' && c.date !== '');

  return {
    stops,
    routes,
    trips,
    stopTimes,
    calendar,
    calendarDates,
    serviceDayStartSeconds,
  };
}

export class GtfsStaticProvider implements StaticProvider {
  constructor(private options: GtfsStaticOptions) {}

  async load(): Promise<ParsedStaticGtfs> {
    const buffer = this.options.force
      ? await downloadStatic(this.options.url, undefined)
      : await downloadStatic(this.options.url, this.options.cachePath);
    return parseStatic(buffer);
  }
}
