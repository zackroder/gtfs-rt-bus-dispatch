import type { AppConfig, TripUpdateInfo, VehiclePositionInfo } from '../../../shared/types';
import type { RealtimeProvider, RealtimeSnapshot } from './types';
import { decodeTripUpdates, decodeVehiclePositions, fetchFeed } from '../gtfs/realtime';

// The provider keeps the last good result for each feed independently so a transient outage
// does not erase usable data from the other feed or from the previous poll.
export class GtfsRealtimeProvider implements RealtimeProvider {
  private lastTripUpdates: TripUpdateInfo[] = [];
  private lastVehiclePositions: VehiclePositionInfo[] = [];
  private lastFetchAt: number | null = null;
  private lastTripUpdatesSuccessAt: number | null = null;
  private lastVehiclePositionsSuccessAt: number | null = null;
  private lastTripUpdatesError: string | null = null;
  private lastVehiclePositionsError: string | null = null;
  private vehiclePositionsFromCache = false;

  constructor(
    private getConfig: () => Pick<AppConfig['realtime'], 'tripUpdatesUrl' | 'vehiclePositionsUrl' | 'apiKey'>,
  ) {}

  private buildUrl(base: string): string {
    const apiKey = this.getConfig().apiKey;
    if (!apiKey) return base;
    // Feed URLs may already contain query parameters, so append the credential with the right separator.
    const separator = base.includes('?') ? '&' : '?';
    return `${base}${separator}key=${encodeURIComponent(apiKey)}`;
  }

  // Fetch both feeds concurrently and return the latest successful value for each one.
  async fetch(): Promise<RealtimeSnapshot> {
    const { tripUpdatesUrl, vehiclePositionsUrl } = this.getConfig();
    const timestamp = Math.floor(Date.now() / 1000);
    this.lastFetchAt = timestamp;
    let tripUpdates: TripUpdateInfo[] = [];
    let vehiclePositions: VehiclePositionInfo[] = [];
    const [tuResult, vpResult] = await Promise.allSettled([
      fetchFeed(this.buildUrl(tripUpdatesUrl)).then((buf) => decodeTripUpdates(buf, timestamp)),
      vehiclePositionsUrl
        ? fetchFeed(this.buildUrl(vehiclePositionsUrl)).then((buf) => decodeVehiclePositions(buf, timestamp))
        : Promise.resolve(vehiclePositions),
    ]);
    // Trip updates and vehicle positions are independent upstream resources; retain each feed's
    // previous successful value rather than failing the complete refresh when one request fails.
    if (tuResult.status === 'fulfilled') {
      this.lastTripUpdates = tuResult.value;
      tripUpdates = this.lastTripUpdates;
      this.lastTripUpdatesSuccessAt = timestamp;
      this.lastTripUpdatesError = null;
    } else {
      tripUpdates = this.lastTripUpdates;
      this.lastTripUpdatesError = tuResult.reason instanceof Error
        ? tuResult.reason.message
        : String(tuResult.reason);
    }
    if (tuResult.status === 'rejected') console.error('trip updates feed failed:', tuResult.reason);
    if (vpResult.status === 'fulfilled') {
      this.lastVehiclePositions = vpResult.value;
      vehiclePositions = this.lastVehiclePositions;
      this.lastVehiclePositionsSuccessAt = timestamp;
      this.lastVehiclePositionsError = null;
      this.vehiclePositionsFromCache = false;
    } else {
      vehiclePositions = this.lastVehiclePositions;
      this.lastVehiclePositionsError = vpResult.reason instanceof Error
        ? vpResult.reason.message
        : String(vpResult.reason);
      this.vehiclePositionsFromCache = true;
    }
    if (vpResult.status === 'rejected') console.error('vehicle positions feed failed:', vpResult.reason);
    return { timestamp, tripUpdates, vehiclePositions };
  }

  // Expose feed health without exposing the configured URLs or API credential.
  getDiagnostics() {
    return {
      lastFetchAt: this.lastFetchAt,
      lastTripUpdatesSuccessAt: this.lastTripUpdatesSuccessAt,
      lastVehiclePositionsSuccessAt: this.lastVehiclePositionsSuccessAt,
      lastTripUpdatesError: this.lastTripUpdatesError,
      lastVehiclePositionsError: this.lastVehiclePositionsError,
      vehiclePositionsFromCache: this.vehiclePositionsFromCache,
      vehiclePositionsConfigured: Boolean(this.getConfig().vehiclePositionsUrl),
      tripUpdatesCount: this.lastTripUpdates.length,
      vehiclePositionsCount: this.lastVehiclePositions.length,
    };
  }
}
