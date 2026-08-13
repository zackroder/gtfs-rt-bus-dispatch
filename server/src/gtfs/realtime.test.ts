import { describe, expect, it } from 'vitest';
import { transit_realtime } from 'gtfs-realtime-bindings';
import { decodeTripUpdates, decodeVehiclePositions } from './realtime';

const FeedMessage = transit_realtime.FeedMessage;

function encodeFeed(header: transit_realtime.IFeedHeader, entities: object[]): Buffer {
  const message = FeedMessage.encode({
    header,
    entity: entities as never,
  }).finish();
  return Buffer.from(message);
}

describe('realtime decode', () => {
  it('normalizes VehiclePositions into VehiclePosition DTOs', () => {
    const buffer = encodeFeed(
      { gtfsRealtimeVersion: '2.0', timestamp: 1700000000 },
      [
        {
          id: 'vp1',
          vehicle: {
            trip: { tripId: 'T1', routeId: '1' },
            vehicle: { id: 'V1' },
            position: { latitude: 41.8, longitude: -87.6 },
            currentStopSequence: 3,
            stopId: 'B',
            timestamp: 1700000001,
          },
        },
        {
          id: 'vp2',
          vehicle: { vehicle: { id: 'V9' }, position: { latitude: 41.7, longitude: -87.5 } },
        },
      ],
    );

    const vehicles = decodeVehiclePositions(buffer, 1700000000);
    expect(vehicles).toHaveLength(2);
    expect(vehicles[0]!.vehicleId).toBe('V1');
    expect(vehicles[0]!.tripId).toBe('T1');
    expect(vehicles[0]!.routeId).toBe('1');
    expect(vehicles[0]!.stopId).toBe('B');
    expect(vehicles[0]!.stopSequence).toBe(3);
    expect(vehicles[0]!.lat).toBeCloseTo(41.8, 5);
    expect(vehicles[0]!.lon).toBeCloseTo(-87.6, 5);
    expect(vehicles[0]!.timestamp).toBe(1700000001);
    expect(vehicles[1]).toMatchObject({ vehicleId: 'V9', tripId: undefined });
  });

  it('normalizes TripUpdates into TripUpdateInfo DTOs', () => {
    const buffer = encodeFeed(
      { gtfsRealtimeVersion: '2.0', timestamp: 1700000000 },
      [
        {
          id: 'tu1',
          tripUpdate: {
            trip: { tripId: 'T2', routeId: '1' },
            vehicle: { id: 'V2' },
            delay: 120,
            stopTimeUpdate: [
              {
                stopSequence: 1,
                stopId: 'A',
                arrival: { delay: 60 },
                departure: { time: 1700001000 },
              },
            ],
            timestamp: 1700000002,
          },
        },
        { id: 'noop' },
      ],
    );

    const updates = decodeTripUpdates(buffer, 1700000000);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      tripId: 'T2',
      vehicleId: 'V2',
      routeId: '1',
      delay: 120,
      timestamp: 1700000002,
    });
    expect(updates[0]!.stopTimeUpdates).toEqual([
      {
        stopId: 'A',
        stopSequence: 1,
        arrivalDelay: 60,
        departureDelay: 0,
        arrivalTime: undefined,
        departureTime: 1700001000,
      },
    ]);
  });

  it('drops entities lacking a trip id in trip updates', () => {
    const buffer = encodeFeed({ gtfsRealtimeVersion: '2.0' }, [
      { id: 'x', tripUpdate: { trip: { routeId: '1' }, stopTimeUpdate: [{ stopId: 'A', stopSequence: 1 }] } },
    ]);
    expect(decodeTripUpdates(buffer, 0)).toHaveLength(0);
  });
});
