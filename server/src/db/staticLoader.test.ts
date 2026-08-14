import { describe, expect, it } from 'vitest';
import { createDatabase } from './schema';
import { deriveBlockTrips, loadStatic } from './staticLoader';
import { syntheticGtfs } from '../test/fixtures';
import { normalizeServiceSeconds } from '../gtfs/time';

describe('staticLoader', () => {
  it('round-trips synthetic GTFS into the SQLite tables', () => {
    const db = createDatabase(':memory:');
    const gtfs = syntheticGtfs({
      stops: [
        { stopId: 'T', name: 'Terminal' },
        { stopId: 'B', name: 'Far' },
      ],
      routes: [{ routeId: '1', shortName: '1' }],
      trips: [
        {
          tripId: 'T1',
          blockId: 'B1',
          stopTimes: [
            { stopId: 'T', arr: '05:00:00', dep: '05:00:00', pickup: 0 },
            { stopId: 'B', arr: '05:30:00', dep: '05:30:00' },
          ],
        },
        {
          tripId: 'T2',
          blockId: 'B1',
          stopTimes: [
            { stopId: 'B', arr: '05:45:00', dep: '05:45:00' },
            { stopId: 'T', arr: '06:15:00', dep: '06:15:00', dropOff: 0 },
          ],
        },
      ],
    });

    loadStatic(db, gtfs);

    expect((db.prepare('SELECT COUNT(*) AS c FROM stops').get() as { c: number }).c).toBe(2);
    expect((db.prepare('SELECT COUNT(*) AS c FROM routes').get() as { c: number }).c).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS c FROM trips').get() as { c: number }).c).toBe(2);
    expect((db.prepare('SELECT COUNT(*) AS c FROM stop_times').get() as { c: number }).c).toBe(4);
    expect((db.prepare('SELECT COUNT(*) AS c FROM calendar').get() as { c: number }).c).toBe(1);

    const dep = db
      .prepare(`SELECT departure_time FROM stop_times WHERE trip_id = ? AND stop_sequence = 0`)
      .get('T1') as { departure_time: number };
    expect(dep.departure_time).toBe(normalizeServiceSeconds(5 * 3600, gtfs.serviceDayStartSeconds));
  });

  it('stores the detected service-day start in settings', () => {
    const db = createDatabase(':memory:');
    const gtfs = syntheticGtfs({
      trips: [
        {
          tripId: 'T1',
          stopTimes: [
            { stopId: 'T', arr: '05:00:00', dep: '05:00:00', pickup: 0 },
            { stopId: 'B', arr: '06:00:00', dep: '06:00:00' },
          ],
        },
      ],
    });
    loadStatic(db, gtfs);
    const row = db
      .prepare(`SELECT value_json FROM settings WHERE key = 'serviceDayStartSeconds'`)
      .get() as { value_json: string };
    expect(JSON.parse(row.value_json)).toBe(gtfs.serviceDayStartSeconds);
  });

  it('derives block_trips as ordered trip chains per block', () => {
    const db = createDatabase(':memory:');
    const gtfs = syntheticGtfs({
      trips: [
        {
          tripId: 'T1',
          blockId: 'B1',
          stopTimes: [
            { stopId: 'T', arr: '06:00:00', dep: '06:00:00' },
            { stopId: 'B', arr: '06:30:00', dep: '06:30:00' },
          ],
        },
        {
          tripId: 'T2',
          blockId: 'B1',
          stopTimes: [
            { stopId: 'B', arr: '06:45:00', dep: '06:45:00' },
            { stopId: 'T', arr: '07:15:00', dep: '07:15:00' },
          ],
        },
        {
          tripId: 'T3',
          blockId: 'B1',
          stopTimes: [
            { stopId: 'T', arr: '07:30:00', dep: '07:30:00' },
            { stopId: 'B', arr: '08:00:00', dep: '08:00:00' },
          ],
        },
        {
          tripId: 'OTHER',
          blockId: 'B2',
          stopTimes: [
            { stopId: 'T', arr: '09:00:00', dep: '09:00:00' },
            { stopId: 'B', arr: '09:30:00', dep: '09:30:00' },
          ],
        },
      ],
    });
    loadStatic(db, gtfs);

    const chain = db
      .prepare(`SELECT seq, trip_id FROM block_trips WHERE block_id = 'B1' ORDER BY seq`)
      .all() as Array<{ seq: number; trip_id: string }>;
    expect(chain).toEqual([
      { seq: 0, trip_id: 'T1' },
      { seq: 1, trip_id: 'T2' },
      { seq: 2, trip_id: 'T3' },
    ]);
  });

  it('drops non-bus routes and their trips, stop_times, and stops', () => {
    const db = createDatabase(':memory:');
    const gtfs = syntheticGtfs({
      stops: [
        { stopId: 'T', name: 'Terminal' },
        { stopId: 'B', name: 'Far' },
        { stopId: 'RAIL', name: 'Rail Platform' },
      ],
      routes: [
        { routeId: 'BUS1', shortName: '72' },
        { routeId: 'RED', shortName: 'Red Line', type: 1 },
      ],
      trips: [
        {
          tripId: 'BUST1',
          routeId: 'BUS1',
          stopTimes: [
            { stopId: 'T', arr: '05:00:00', dep: '05:00:00' },
            { stopId: 'B', arr: '05:30:00', dep: '05:30:00' },
          ],
        },
        {
          tripId: 'RAILT1',
          routeId: 'RED',
          stopTimes: [
            { stopId: 'RAIL', arr: '05:00:00', dep: '05:00:00' },
            { stopId: 'T', arr: '05:30:00', dep: '05:30:00' },
          ],
        },
      ],
    });
    loadStatic(db, gtfs);

    expect((db.prepare('SELECT COUNT(*) AS c FROM routes').get() as { c: number }).c).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS c FROM trips').get() as { c: number }).c).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS c FROM stop_times').get() as { c: number }).c).toBe(2);
    expect(
      (db.prepare(`SELECT COUNT(*) AS c FROM stops WHERE stop_id = 'RAIL'`).get() as { c: number }).c,
    ).toBe(0);
    expect(
      (db.prepare(`SELECT COUNT(*) AS c FROM trips WHERE trip_id = 'RAILT1'`).get() as { c: number }).c,
    ).toBe(0);
  });

  it('replaces static data on reload instead of appending or failing', () => {
    const db = createDatabase(':memory:');
    loadStatic(
      db,
      syntheticGtfs({
        routes: [
          { routeId: 'BUS1', shortName: '72' },
          { routeId: 'RED', shortName: 'Red Line', type: 1 },
        ],
        trips: [
          {
            tripId: 'BUST1',
            routeId: 'BUS1',
            stopTimes: [
              { stopId: 'T', arr: '05:00:00', dep: '05:00:00' },
              { stopId: 'B', arr: '05:30:00', dep: '05:30:00' },
            ],
          },
          {
            tripId: 'RAILT1',
            routeId: 'RED',
            stopTimes: [
              { stopId: 'T', arr: '06:00:00', dep: '06:00:00' },
              { stopId: 'RAIL', arr: '06:30:00', dep: '06:30:00' },
            ],
          },
        ],
      }),
    );
    expect((db.prepare('SELECT COUNT(*) AS c FROM routes').get() as { c: number }).c).toBe(1);

    loadStatic(
      db,
      syntheticGtfs({
        routes: [{ routeId: 'BUS1', shortName: '72' }],
        trips: [
          {
            tripId: 'BUST2',
            routeId: 'BUS1',
            stopTimes: [
              { stopId: 'T', arr: '07:00:00', dep: '07:00:00' },
              { stopId: 'B', arr: '07:30:00', dep: '07:30:00' },
            ],
          },
        ],
      }),
    );

    expect((db.prepare('SELECT COUNT(*) AS c FROM routes').get() as { c: number }).c).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS c FROM trips').get() as { c: number }).c).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS c FROM stop_times').get() as { c: number }).c).toBe(2);
    expect((db.prepare('SELECT COUNT(*) AS c FROM stops').get() as { c: number }).c).toBe(2);
  });

  it('does not chain trips without a block_id', () => {
    const db = createDatabase(':memory:');
    const gtfs = syntheticGtfs({
      trips: [
        {
          tripId: 'T1',
          stopTimes: [
            { stopId: 'T', arr: '05:00:00', dep: '05:00:00' },
            { stopId: 'B', arr: '05:30:00', dep: '05:30:00' },
          ],
        },
      ],
    });
    loadStatic(db, gtfs);
    expect((db.prepare('SELECT COUNT(*) AS c FROM block_trips').get() as { c: number }).c).toBe(0);
    deriveBlockTrips(db);
    expect((db.prepare('SELECT COUNT(*) AS c FROM block_trips').get() as { c: number }).c).toBe(0);
  });
});
