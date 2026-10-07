import { describe, expect, it } from 'vitest';
import { createDatabase } from '../db/schema';
import { loadStatic } from '../db/staticLoader';
import {
  ACTIVITY_LOOKBACK_SECONDS,
  activeRoutesAtTerminal,
  autoDiscoverTerminals,
  discoveryServiceIds,
  inboundTrips,
  outboundTrips,
} from './terminal';
import { syntheticGtfs } from '../test/fixtures';
import { activeServiceIds, getServiceDayStart } from '../gtfs/time';

// Terminal fixtures use short two-stop routes to make endpoint direction and pickup/drop-off
// filtering explicit without depending on a full agency schedule.
describe('terminal resolution', () => {
  it('auto-discovers terminals from route first stops, grouped when co-located', () => {
    const db = createDatabase(':memory:');
    const gtfs = syntheticGtfs({
      stops: [
        { stopId: 'T', name: 'Terminal' },
        { stopId: 'B', name: 'Far' },
        { stopId: 'D', name: 'Depot' },
      ],
      routes: [
        { routeId: '1', shortName: '1' },
        { routeId: '2', shortName: '2' },
        { routeId: '3', shortName: '3' },
      ],
      trips: [
        {
          tripId: '1-1',
          routeId: '1',
          stopTimes: [
            { stopId: 'T', arr: '08:00:00', dep: '08:00:00' },
            { stopId: 'B', arr: '08:30:00', dep: '08:30:00' },
          ],
        },
        {
          tripId: '1-2',
          routeId: '1',
          stopTimes: [
            { stopId: 'T', arr: '08:15:00', dep: '08:15:00' },
            { stopId: 'B', arr: '08:45:00', dep: '08:45:00' },
          ],
        },
        {
          tripId: '2-1',
          routeId: '2',
          stopTimes: [
            { stopId: 'T', arr: '08:10:00', dep: '08:10:00' },
            { stopId: 'B', arr: '08:40:00', dep: '08:40:00' },
          ],
        },
        {
          tripId: '2-2',
          routeId: '2',
          stopTimes: [
            { stopId: 'T', arr: '08:25:00', dep: '08:25:00' },
            { stopId: 'B', arr: '08:55:00', dep: '08:55:00' },
          ],
        },
        {
          tripId: '3-1',
          routeId: '3',
          stopTimes: [
            { stopId: 'D', arr: '09:00:00', dep: '09:00:00' },
            { stopId: 'B', arr: '09:30:00', dep: '09:30:00' },
          ],
        },
        {
          tripId: '3-2',
          routeId: '3',
          stopTimes: [
            { stopId: 'D', arr: '09:15:00', dep: '09:15:00' },
            { stopId: 'B', arr: '09:45:00', dep: '09:45:00' },
          ],
        },
      ],
    });
    loadStatic(db, gtfs);

    const active = activeServiceIds(db, '20260813');
    const terminals = autoDiscoverTerminals(db, active);
    const terminal = terminals.find((t) => t.id === 'T');
    const depot = terminals.find((t) => t.id === 'D');
    expect(terminal).toBeDefined();
    expect(terminal!.name).toBe('Terminal');
    expect(terminal!.routeIds!.sort()).toEqual(['1', '2']);
    expect(depot).toBeDefined();
    expect(depot!.routeIds).toEqual(['3']);
  });

  it('discovers a terminal at each end of a route', () => {
    const db = createDatabase(':memory:');
    const gtfs = syntheticGtfs({
      stops: [
        { stopId: 'A', name: 'A' },
        { stopId: 'B', name: 'B' },
      ],
      trips: [
        {
          tripId: 'OUT',
          routeId: '1',
          stopTimes: [
            { stopId: 'A', arr: '08:00:00', dep: '08:00:00' },
            { stopId: 'B', arr: '08:30:00', dep: '08:30:00' },
          ],
        },
        {
          tripId: 'OUT2',
          routeId: '1',
          stopTimes: [
            { stopId: 'A', arr: '08:20:00', dep: '08:20:00' },
            { stopId: 'B', arr: '08:50:00', dep: '08:50:00' },
          ],
        },
        {
          tripId: 'IN',
          routeId: '1',
          stopTimes: [
            { stopId: 'B', arr: '09:00:00', dep: '09:00:00' },
            { stopId: 'A', arr: '09:30:00', dep: '09:30:00' },
          ],
        },
        {
          tripId: 'IN2',
          routeId: '1',
          stopTimes: [
            { stopId: 'B', arr: '09:20:00', dep: '09:20:00' },
            { stopId: 'A', arr: '09:50:00', dep: '09:50:00' },
          ],
        },
      ],
    });
    loadStatic(db, gtfs);

    const active = activeServiceIds(db, '20260813');
    const terminals = autoDiscoverTerminals(db, active);
    const atA = terminals.find((t) => t.id === 'A');
    const atB = terminals.find((t) => t.id === 'B');
    expect(atA).toBeDefined();
    expect(atA!.routeIds).toEqual(['1']);
    expect(atB).toBeDefined();
    expect(atB!.routeIds).toEqual(['1']);
  });

  it('resolves outbound and inbound trips per terminal stop', () => {
    const db = createDatabase(':memory:');
    const gtfs = syntheticGtfs({
      trips: [
        {
          tripId: 'OUT',
          stopTimes: [
            { stopId: 'T', arr: '08:00:00', dep: '08:00:00', pickup: 0 },
            { stopId: 'B', arr: '08:30:00', dep: '08:30:00', dropOff: 0 },
          ],
        },
        {
          tripId: 'IN',
          stopTimes: [
            { stopId: 'B', arr: '09:00:00', dep: '09:00:00', pickup: 0 },
            { stopId: 'T', arr: '09:30:00', dep: '09:30:00', dropOff: 0 },
          ],
        },
        {
          tripId: 'NO_BOARD',
          stopTimes: [
            { stopId: 'T', arr: '10:00:00', dep: '10:00:00', pickup: 1 },
            { stopId: 'B', arr: '10:30:00', dep: '10:30:00', dropOff: 0 },
          ],
        },
      ],
    });
    loadStatic(db, gtfs);

    const active = activeServiceIds(db, '20260813');
    const outbound = outboundTrips(db, '1', ['T'], active, 0, 86400);
    const inbound = inboundTrips(db, '1', ['T'], active, 0, 86400);
    expect(outbound.map((o) => o.tripId)).toEqual(['OUT']);
    expect(inbound.map((o) => o.tripId)).toEqual(['IN']);
  });
});

// A single route with a morning terminal variant (A), a midday variant (B), and a one-off
// deadhead (C); used to verify both variant discovery and the windowed activity query.
function variantGtfs() {
  return syntheticGtfs({
    routes: [{ routeId: '9', shortName: '9' }],
    stops: [
      { stopId: 'O', name: 'Origin' },
      { stopId: 'A', name: 'Morning End' },
      { stopId: 'B', name: 'Midday End' },
      { stopId: 'C', name: 'Deadhead End' },
    ],
    trips: [
      {
        tripId: 'AM-1',
        routeId: '9',
        directionId: 1,
        stopTimes: [
          { stopId: 'O', arr: '06:30:00', dep: '06:30:00' },
          { stopId: 'A', arr: '07:00:00', dep: '07:00:00' },
        ],
      },
      {
        tripId: 'AM-2',
        routeId: '9',
        directionId: 1,
        stopTimes: [
          { stopId: 'O', arr: '06:45:00', dep: '06:45:00' },
          { stopId: 'A', arr: '07:15:00', dep: '07:15:00' },
        ],
      },
      {
        tripId: 'PM-1',
        routeId: '9',
        directionId: 1,
        stopTimes: [
          { stopId: 'O', arr: '11:30:00', dep: '11:30:00' },
          { stopId: 'B', arr: '12:00:00', dep: '12:00:00' },
        ],
      },
      {
        tripId: 'PM-2',
        routeId: '9',
        directionId: 1,
        stopTimes: [
          { stopId: 'O', arr: '11:45:00', dep: '11:45:00' },
          { stopId: 'B', arr: '12:15:00', dep: '12:15:00' },
        ],
      },
      {
        tripId: 'DH-1',
        routeId: '9',
        directionId: 1,
        stopTimes: [
          { stopId: 'O', arr: '08:30:00', dep: '08:30:00' },
          { stopId: 'C', arr: '09:00:00', dep: '09:00:00' },
        ],
      },
    ],
  });
}

describe('time-of-day terminal discovery and activity', () => {
  it('keeps every endpoint variant above the trip threshold and drops one-off deadheads', () => {
    const db = createDatabase(':memory:');
    loadStatic(db, variantGtfs());
    const terminals = autoDiscoverTerminals(db, activeServiceIds(db, '20260813'));
    const ids = terminals.map((t) => t.id);
    expect(ids).toContain('A');
    expect(ids).toContain('B');
    // C is served by a single deadhead trip, below DISCOVERY_MIN_TRIPS.
    expect(ids).not.toContain('C');
  });

  it('discovers a variant served only by a service outside today (7-day scope)', () => {
    const db = createDatabase(':memory:');
    db.prepare(`INSERT INTO routes (route_id, agency_id, short_name, long_name, type) VALUES (?,?,?,?,?)`)
      .run('9', 'A', '9', 'Route Nine', 3);
    const insertStop = db.prepare(
      `INSERT INTO stops (stop_id, stop_code, stop_name, parent_station, lat, lon) VALUES (?,?,?,?,?,?)`,
    );
    insertStop.run('W', 'W', 'Weekend End', null, 41.8, -87.6);
    insertStop.run('A', 'A', 'Weekday End', null, 41.7, -87.7);
    const insertTrip = db.prepare(
      `INSERT INTO trips (trip_id, route_id, service_id, block_id, direction_id, headsign) VALUES (?,?,?,?,?,?)`,
    );
    insertTrip.run('WKD-1', '9', 'SVC_WEEKDAY', null, 1, null);
    insertTrip.run('WKD-2', '9', 'SVC_WEEKDAY', null, 1, null);
    insertTrip.run('WKE-1', '9', 'SVC_WEEKEND', null, 1, null);
    insertTrip.run('WKE-2', '9', 'SVC_WEEKEND', null, 1, null);
    const insertStopTime = db.prepare(
      `INSERT INTO stop_times (trip_id, stop_sequence, stop_id, arrival_time, departure_time, pickup_type, drop_off_type) VALUES (?,?,?,?,?,?,?)`,
    );
    insertStopTime.run('WKD-1', 0, 'A', 25200, 25200, 0, 0);
    insertStopTime.run('WKD-2', 0, 'A', 28800, 28800, 0, 0);
    insertStopTime.run('WKE-1', 0, 'W', 25200, 25200, 0, 0);
    insertStopTime.run('WKE-2', 0, 'W', 28800, 28800, 0, 0);
    const insertCalendar = db.prepare(
      `INSERT INTO calendar (service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    insertCalendar.run('SVC_WEEKDAY', 1, 1, 1, 1, 1, 0, 0, '20200101', '20991231');
    insertCalendar.run('SVC_WEEKEND', 0, 0, 0, 0, 0, 1, 1, '20200101', '20991231');

    // 20260817 is a Monday: today's services exclude the weekend-only W endpoint.
    const todayOnly = autoDiscoverTerminals(db, activeServiceIds(db, '20260817'));
    expect(todayOnly.some((t) => t.id === 'W')).toBe(false);

    const weekIds = discoveryServiceIds(db, '20260817', 7);
    expect(weekIds.has('SVC_WEEKEND')).toBe(true);
    const weekTerminals = autoDiscoverTerminals(db, weekIds);
    expect(weekTerminals.some((t) => t.id === 'W')).toBe(true);
  });

  it('marks terminal endpoints active only inside the current window', () => {
    const db = createDatabase(':memory:');
    loadStatic(db, variantGtfs());
    const start = getServiceDayStart(db);
    // Schedule times are stored on the service-day clock; mirror that mapping for the test clock.
    const at = (hour: number, minute: number) => {
      const raw = hour * 3600 + minute * 60;
      return ((raw - start) % 86400 + 86400) % 86400;
    };
    const active = activeServiceIds(db, '20260813');
    const windowAt = (hour: number, minute: number): [number, number] => [
      at(hour, minute) - ACTIVITY_LOOKBACK_SECONDS,
      at(hour, minute) + 90 * 60,
    ];

    const [morningFrom, morningTo] = windowAt(7, 0);
    expect(activeRoutesAtTerminal(db, ['A'], active, morningFrom, morningTo)).toEqual(['9']);
    expect(activeRoutesAtTerminal(db, ['B'], active, morningFrom, morningTo)).toEqual([]);

    const [middayFrom, middayTo] = windowAt(12, 0);
    expect(activeRoutesAtTerminal(db, ['A'], active, middayFrom, middayTo)).toEqual([]);
    expect(activeRoutesAtTerminal(db, ['B'], active, middayFrom, middayTo)).toEqual(['9']);

    const [nightFrom, nightTo] = windowAt(23, 0);
    expect(activeRoutesAtTerminal(db, ['A'], active, nightFrom, nightTo)).toEqual([]);
    expect(activeRoutesAtTerminal(db, ['B'], active, nightFrom, nightTo)).toEqual([]);
  });
});
