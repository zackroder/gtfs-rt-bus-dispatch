import { describe, expect, it } from 'vitest';
import { transit_realtime } from 'gtfs-realtime-bindings';
import { decodeTripUpdates, decodeVehiclePositions } from './realtime';

const FeedMessage = transit_realtime.FeedMessage;

// Encode real protobuf messages so decoder tests cover the Long/nested-field normalization boundary.
function encodeFeed(header: transit_realtime.IFeedHeader, entities: object[]): Buffer {
  const message = FeedMessage.encode({
    header,
    entity: entities as never,
  }).finish();
  return Buffer.from(message);
}

describe('realtime decode', () => {
  // Fixtures include valid entities and ignored incomplete entities to define the DTO contract.
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

  it('normalizes VehiclePositions into VehiclePositionInfo DTOs', () => {
    const buffer = encodeFeed(
      { gtfsRealtimeVersion: '2.0', timestamp: 1700000000 },
      [
        {
          id: 'vp1',
          vehicle: {
            vehicle: { id: 'V1' },
            trip: { tripId: 'T1', routeId: '1' },
            position: { latitude: 41.88, longitude: -87.63 },
            currentStopSequence: 12,
            stopId: 'STOP12',
            timestamp: 1700000005,
          },
        },
        {
          id: 'vp-minimal',
          vehicle: {
            vehicle: { id: 'V2' },
            timestamp: 1700000006,
          },
        },
        { id: 'noop' },
      ],
    );

    const positions = decodeVehiclePositions(buffer, 1700000000);
    // Lat/lon pass through the protobuf 32-bit float boundary, so compare within float precision.
    expect(positions).toHaveLength(2);
    expect(positions[0]).toMatchObject({
      vehicleId: 'V1',
      tripId: 'T1',
      stopId: 'STOP12',
      currentStopSequence: 12,
      timestamp: 1700000005,
    });
    expect(positions[0]!.lat).toBeCloseTo(41.88, 4);
    expect(positions[0]!.lon).toBeCloseTo(-87.63, 4);
    expect(positions[1]).toEqual({
      vehicleId: 'V2',
      tripId: undefined,
      stopId: undefined,
      currentStopSequence: undefined,
      lat: undefined,
      lon: undefined,
      timestamp: 1700000006,
    });
  });
});
