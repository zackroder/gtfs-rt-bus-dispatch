import type { AppConfig } from '../../../shared/types';
import type { TripUpdateInfo, VehiclePosition } from '../../../shared/types';
import type { RealtimeProvider, RealtimeSnapshot } from './types';
import { decodeTripUpdates, decodeVehiclePositions, fetchFeed } from '../gtfs/realtime';

export class GtfsRealtimeProvider implements RealtimeProvider {
  constructor(
    private getConfig: () => Pick<AppConfig['realtime'], 'vehiclePositionsUrl' | 'tripUpdatesUrl' | 'apiKey'>,
  ) {}

  private buildUrl(base: string): string {
    const apiKey = this.getConfig().apiKey;
    if (!apiKey) return base;
    const separator = base.includes('?') ? '&' : '?';
    return `${base}${separator}key=${encodeURIComponent(apiKey)}`;
  }

  async fetch(): Promise<RealtimeSnapshot> {
    const { vehiclePositionsUrl, tripUpdatesUrl } = this.getConfig();
    const timestamp = Math.floor(Date.now() / 1000);
    let vehicles: VehiclePosition[] = [];
    let tripUpdates: TripUpdateInfo[] = [];
    const results = await Promise.allSettled([
      fetchFeed(this.buildUrl(vehiclePositionsUrl)),
      fetchFeed(this.buildUrl(tripUpdatesUrl)),
    ]);
    if (results[0]?.status === 'fulfilled') {
      vehicles = decodeVehiclePositions(results[0].value, timestamp);
    } else if (results[0]?.status === 'rejected') {
      console.error('vehicle positions feed failed:', results[0].reason);
    }
    if (results[1]?.status === 'fulfilled') {
      tripUpdates = decodeTripUpdates(results[1].value, timestamp);
    } else if (results[1]?.status === 'rejected') {
      console.error('trip updates feed failed:', results[1].reason);
    }
    return { timestamp, vehicles, tripUpdates };
  }
}
