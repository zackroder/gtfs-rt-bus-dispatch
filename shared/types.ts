import { z } from 'zod';

export interface Terminal {
  id: string;
  name: string;
  stopIds: string[];
  routeIds?: string[];
}

export interface Stop {
  stopId: string;
  stopCode?: string;
  stopName: string;
  lat: number;
  lon: number;
}

export interface VehiclePosition {
  vehicleId: string;
  tripId?: string;
  routeId?: string;
  stopId?: string;
  stopSequence?: number;
  lat?: number;
  lon?: number;
  timestamp: number;
}

export interface StopTimePrediction {
  stopId: string;
  stopSequence: number;
  arrivalDelay?: number;
  departureDelay?: number;
  arrivalTime?: number;
  departureTime?: number;
}

export interface TripUpdateInfo {
  tripId: string;
  vehicleId?: string;
  routeId?: string;
  delay?: number;
  stopTimeUpdates: StopTimePrediction[];
  timestamp: number;
}

export interface IncomingBus {
  routeId: string;
  routeShortName: string;
  tripId: string;
  vehicleId?: string;
  scheduledArrival: number;
  predictedArrival: number;
  etaSeconds: number;
  delaySeconds: number;
}

export interface HoldOverride {
  holdSeconds: number;
  effectiveDeparture: number;
  rule: 'leader' | 'follower';
  reason: string;
}

export interface LayoverBus {
  routeId: string;
  routeShortName: string;
  tripId: string;
  vehicleId?: string;
  scheduledDeparture: number;
  predictedDeparture: number;
  countdownSeconds: number;
  hold?: HoldOverride;
  minRestAdvisory?: boolean;
}

export type InterventionRule = 'hold_leader' | 'hold_follower' | 'gap_alert' | 'min_rest';

export interface Intervention {
  id: string;
  terminalId: string;
  routeId: string;
  rule: InterventionRule;
  vehicleId?: string;
  leaderVehicleId?: string;
  followerVehicleId?: string;
  holdSeconds: number;
  reason: string;
  until?: number;
  generatedAt: number;
}

export interface RouteState {
  routeId: string;
  routeShortName: string;
  incoming: IncomingBus[];
  layovers: LayoverBus[];
  interventions: Intervention[];
}

export interface TerminalSnapshot {
  terminalId: string;
  generatedAt: number;
  routes: RouteState[];
}

export interface AppConfig {
  realtime: {
    vehiclePositionsUrl: string;
    tripUpdatesUrl: string;
    apiKey?: string;
  };
  staticGtfsUrl: string;
  refreshIntervalSeconds: number;
  staticRefreshHours: number;
  minRestMinutes: number;
  gapFactor: number;
  bunchFactor: number;
  holdFraction: number;
  maxHoldMinutes: number;
  leadTimeMinutes: number;
  lookaheadMinutes: number;
  terminals: Terminal[];
}

export const terminalSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  stopIds: z.array(z.string().min(1)).min(1),
  routeIds: z.array(z.string().min(1)).optional(),
});

export const appConfigSchema = z.object({
  realtime: z.object({
    vehiclePositionsUrl: z.string().url(),
    tripUpdatesUrl: z.string().url(),
    apiKey: z.string().optional(),
  }),
  staticGtfsUrl: z.string().url(),
  refreshIntervalSeconds: z.number().int().min(5).max(3600),
  staticRefreshHours: z.number().int().min(0).max(720),
  minRestMinutes: z.number().int().min(0).max(600),
  gapFactor: z.number().min(1).max(10),
  bunchFactor: z.number().min(0).max(1),
  holdFraction: z.number().min(0).max(1),
  maxHoldMinutes: z.number().int().min(0).max(600),
  leadTimeMinutes: z.number().int().min(0).max(600),
  lookaheadMinutes: z.number().int().min(5).max(1440),
  terminals: z.array(terminalSchema),
});
