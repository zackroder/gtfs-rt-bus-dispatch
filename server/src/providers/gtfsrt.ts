import type { AppConfig, TripUpdateInfo, VehiclePositionInfo } from '../../../shared/types';
import type { RealtimeProvider, RealtimeSnapshot } from './types';
import { decodeTripUpdates, decodeVehiclePositions, fetchFeed } from '../gtfs/realtime';

export class GtfsRealtimeProvider implements RealtimeProvider {
  constructor(
    private getConfig: () => Pick<AppConfig['realtime'], 'tripUpdatesUrl' | 'vehiclePositionsUrl' | 'apiKey'>,
  ) {}

  private buildUrl(base: string): string {
    const apiKey = this.getConfig().apiKey;
    if (!apiKey) return base;
    const separator = base.includes('?') ? '&' : '?';
    return `${base}${separator}key=${encodeURIComponent(apiKey)}`;
  }

  async fetch(): Promise<RealtimeSnapshot> {
    const { tripUpdatesUrl, vehiclePositionsUrl } = this.getConfig();
    const timestamp = Math.floor(Date.now() / 1000);
    let tripUpdates: TripUpdateInfo[] = [];
    let vehiclePositions: VehiclePositionInfo[] = [];
    const [tuResult, vpResult] = await Promise.allSettled([
      fetchFeed(this.buildUrl(tripUpdatesUrl)).then((buf) => decodeTripUpdates(buf, timestamp)),
      vehiclePositionsUrl
        ? fetchFeed(this.buildUrl(vehiclePositionsUrl)).then((buf) => decodeVehiclePositions(buf, timestamp))
        : Promise.resolve(vehiclePositions),
    ]);
    if (tuResult.status === 'fulfilled') tripUpdates = tuResult.value;
    else console.error('trip updates feed failed:', tuResult.reason);
    if (vpResult.status === 'fulfilled') vehiclePositions = vpResult.value;
    else console.error('vehicle positions feed failed:', vpResult.reason);
    return { timestamp, tripUpdates, vehiclePositions };
  }
}
