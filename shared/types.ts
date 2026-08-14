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

export interface VehiclePositionInfo {
  vehicleId: string;
  tripId?: string;
  stopId?: string;
  currentStopSequence?: number;
  timestamp: number;
}

export interface IncomingBus {
  routeId: string;
  routeShortName: string;
  tripId: string;             // current inbound trip
  vehicleId?: string;
  scheduledArrival: number;
  predictedArrival: number;
  etaSeconds: number;
  delaySeconds: number;
  nextTripId: string;         // outbound trip the vehicle will operate next
  nextDestination: string;    // last stop name of the next trip
  scheduledDeparture: number;
  expectedDeparture: number;  // EDT of the next trip
  restDelayed?: boolean;
}

export interface DepartedBus {
  routeId: string;
  routeShortName: string;
  tripId: string;
  vehicleId?: string;
  headsign?: string;          // last stop name of the departed trip
  scheduledDeparture: number;
  departureSeconds: number;   // recorded actual departure
  held?: boolean;             // the departure was held by a locked hold
  currentStop?: string;       // stop name the vehicle is at now (from VP)
}

export interface HoldOverride {
  holdSeconds: number;
  effectiveDeparture: number;
  reason: string;
}

export interface LayoverBus {
  routeId: string;
  routeShortName: string;
  tripId: string;
  vehicleId?: string;
  scheduledDeparture: number;
  scheduledArrival: number;   // scheduled terminal arrival of the previous trip in block
  terminalArrival: number;
  expectedDeparture: number;
  predictedDeparture: number;
  countdownSeconds: number;
  hold?: HoldOverride;
  restDelayed?: boolean;
}

export type InterventionRule = 'hold';

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
  departed: DepartedBus[];
  interventions: Intervention[];
}

export interface TerminalSnapshot {
  terminalId: string;
  generatedAt: number;        // unix seconds
  serviceDayStartSeconds: number;
  routes: RouteState[];
}

export interface AppConfig {
  realtime: {
    tripUpdatesUrl: string;
    vehiclePositionsUrl?: string;
    apiKey?: string;
  };
  staticGtfsUrl: string;
  refreshIntervalSeconds: number;
  staticRefreshHours: number;
  minRestMinutes: number;
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
    tripUpdatesUrl: z.string().url(),
    vehiclePositionsUrl: z.string().url().optional(),
    apiKey: z.string().optional(),
  }),
  staticGtfsUrl: z.string().url(),
  refreshIntervalSeconds: z.number().int().min(5).max(3600),
  staticRefreshHours: z.number().int().min(0).max(720),
  minRestMinutes: z.number().int().min(0).max(600),
  maxHoldMinutes: z.number().int().min(0).max(600),
  leadTimeMinutes: z.number().int().min(0).max(600),
  lookaheadMinutes: z.number().int().min(5).max(1440),
  terminals: z.array(terminalSchema),
});
