import { describe, expect, it } from 'vitest';
import { createDatabase } from '../db/schema';
import { loadStatic } from '../db/staticLoader';
import { autoDiscoverTerminals, outboundTrips, inboundTrips } from './terminal';
import { syntheticGtfs } from '../test/fixtures';
import { activeServiceIds } from '../gtfs/time';

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
          tripId: '2-1',
          routeId: '2',
          stopTimes: [
            { stopId: 'T', arr: '08:10:00', dep: '08:10:00' },
            { stopId: 'B', arr: '08:40:00', dep: '08:40:00' },
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
