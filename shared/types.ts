/**
 * Shared transport contracts for the dispatch API, websocket stream, and web UI.
 *
 * These interfaces describe the normalized data exchanged across the server/client
 * boundary, while the Zod schemas below validate untrusted JSON at that boundary.
 */
import { z } from 'zod';

/** A configured terminal and the GTFS stops that identify its operating area. */
export interface Terminal {
  id: string;
  name: string;
  stopIds: string[];
  routeIds?: string[];
  /** Optional per-terminal proximity radius (meters) for arrival/layover detection. */
  radiusMeters?: number;
}

/** The small stop projection needed by terminal resolution and display. */
export interface Stop {
  stopId: string;
  stopCode?: string;
  stopName: string;
  lat: number;
  lon: number;
}

/** A GTFS-RT stop-time prediction normalized to seconds and delay values. */
export interface StopTimePrediction {
  stopId: string;
  stopSequence: number;
  arrivalDelay?: number;
  departureDelay?: number;
  arrivalTime?: number;
  departureTime?: number;
}

/** Trip-level realtime information, including its ordered stop updates. */
export interface TripUpdateInfo {
  tripId: string;
  vehicleId?: string;
  routeId?: string;
  delay?: number;
  stopTimeUpdates: StopTimePrediction[];
  timestamp: number;
}

/** Vehicle-position information used to associate a vehicle with a trip and stop. */
export interface VehiclePositionInfo {
  vehicleId: string;
  tripId?: string;
  stopId?: string;
  currentStopSequence?: number;
  lat?: number;
  lon?: number;
  timestamp: number;
}

/** An inbound vehicle that is expected to form the next outbound departure. */
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

/** A bus that has already departed and remains visible for recent operational context. */
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

/** A runtime hold applied to a layover's expected departure. */
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
  terminalArrival?: number;
  terminalArrivalSource?: 'observed' | 'estimated';
  expectedDeparture: number;
  predictedDeparture: number;
  countdownSeconds: number;
  hold?: HoldOverride;
  restDelayed?: boolean;
}

/** The intervention strategy currently supported by the dispatch engine. */
export type InterventionRule = 'hold';

/** Lifecycle states persisted for a generated intervention. */
export type InterventionStatus =
  | 'pending'
  | 'applied'
  | 'declined'
  | 'canceled'
  | 'expired'
  | 'completed';

/** Audit actions recorded when an operator or manager interacts with an intervention. */
export type InterventionAction =
  | 'created'
  | 'viewed'
  | 'applied'
  | 'declined'
  | 'canceled'
  | 'expired'
  | 'completed';

/** A durable recommendation and its operational/audit lifecycle fields. */
export interface Intervention {
  id: string;
  serviceDate: string;
  terminalId: string;
  routeId: string;
  rule: InterventionRule;
  tripId: string;
  vehicleId?: string;
  leaderVehicleId?: string;
  followerVehicleId?: string;
  holdSeconds: number;
  reason: string;
  until?: number;
  generatedAt: number;
  expiresAt?: number;
  status: InterventionStatus;
  appliedAt?: number;
  resolvedAt?: number;
}

/** All displayable vehicle and intervention groups for one route at a terminal. */
export interface RouteState {
  routeId: string;
  routeShortName: string;
  routeLongName?: string;
  color?: string;
  textColor?: string;
  incoming: IncomingBus[];
  layovers: LayoverBus[];
  departed: DepartedBus[];
  interventions: Intervention[];
}

/** Complete point-in-time terminal data broadcast to the web client. */
export interface TerminalSnapshot {
  terminalId: string;
  generatedAt: number;        // unix seconds
  serviceDayStartSeconds: number;
  routes: RouteState[];
}

/** Runtime configuration shared by the settings page and configuration API. */
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
  /** Radius (meters) around a terminal stop within which a parked bus is counted as arrived. */
  arrivalRadiusMeters?: number;
  /** Displacement (meters) between polls that still counts as "parked" for arrival/departure arms. */
  stationaryDisplacementMeters?: number;
  /** Consecutive parked polls required before a proximity arm becomes a committed arrival fact. */
  confirmPings?: number;
  /** Consecutive moving/outside-buffer polls required before a layover becomes a committed departure. */
  departPings?: number;
  /** Grace (seconds) after the scheduled arrival before the scheduled-arm fallback fires. */
  scheduleArmGraceSeconds?: number;
}

/** Validates terminal identity and its non-empty stop membership. */
export const terminalSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  stopIds: z.array(z.string().min(1)).min(1),
  routeIds: z.array(z.string().min(1)).optional(),
  radiusMeters: z.number().int().min(0).max(5000).optional(),
});

/** Optional metadata sent with an intervention action for tracing/audit purposes. */
export const interventionActionSchema = z.object({
  actorId: z.string().min(1).max(200).optional(),
  requestId: z.string().min(1).max(200).optional(),
});

/** Validates configuration before it is sent to or accepted from the server. */
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
  arrivalRadiusMeters: z.number().int().min(0).max(5000).optional(),
  stationaryDisplacementMeters: z.number().int().min(0).max(1000).optional(),
  confirmPings: z.number().int().min(1).max(30).optional(),
  departPings: z.number().int().min(1).max(30).optional(),
  scheduleArmGraceSeconds: z.number().int().min(0).max(3600).optional(),
});

// Nested vehicle DTO schemas are kept private because callers consume them through
// the public route and snapshot schemas below.
const holdOverrideSchema = z.object({
  holdSeconds: z.number(),
  effectiveDeparture: z.number(),
  reason: z.string(),
});

/** Validates an inbound vehicle projection in a route snapshot. */
const incomingBusSchema = z.object({
  routeId: z.string(),
  routeShortName: z.string(),
  tripId: z.string(),
  vehicleId: z.string().optional(),
  scheduledArrival: z.number(),
  predictedArrival: z.number(),
  etaSeconds: z.number(),
  delaySeconds: z.number(),
  nextTripId: z.string(),
  nextDestination: z.string(),
  scheduledDeparture: z.number(),
  expectedDeparture: z.number(),
  restDelayed: z.boolean().optional(),
});

/** Validates a layover projection, including optional arrival source and hold data. */
const layoverBusSchema = z.object({
  routeId: z.string(),
  routeShortName: z.string(),
  tripId: z.string(),
  vehicleId: z.string().optional(),
  scheduledDeparture: z.number(),
  scheduledArrival: z.number(),
  terminalArrival: z.number().optional(),
  terminalArrivalSource: z.enum(['observed', 'estimated']).optional(),
  expectedDeparture: z.number(),
  predictedDeparture: z.number(),
  countdownSeconds: z.number(),
  hold: holdOverrideSchema.optional(),
  restDelayed: z.boolean().optional(),
});

/** Validates a recently departed vehicle projection. */
const departedBusSchema = z.object({
  routeId: z.string(),
  routeShortName: z.string(),
  tripId: z.string(),
  vehicleId: z.string().optional(),
  headsign: z.string().optional(),
  scheduledDeparture: z.number(),
  departureSeconds: z.number(),
  held: z.boolean().optional(),
  currentStop: z.string().optional(),
});

/** Validates the persisted intervention shape sent to the UI. */
export const interventionSchema = z.object({
  id: z.string(),
  serviceDate: z.string(),
  terminalId: z.string(),
  routeId: z.string(),
  rule: z.literal('hold'),
  tripId: z.string(),
  vehicleId: z.string().optional(),
  leaderVehicleId: z.string().optional(),
  followerVehicleId: z.string().optional(),
  holdSeconds: z.number(),
  reason: z.string(),
  until: z.number().optional(),
  generatedAt: z.number(),
  expiresAt: z.number().optional(),
  status: z.enum(['pending', 'applied', 'declined', 'canceled', 'expired', 'completed']),
  appliedAt: z.number().optional(),
  resolvedAt: z.number().optional(),
});

/** Validates one route and all of its terminal display groups. */
const routeStateSchema = z.object({
  routeId: z.string(),
  routeShortName: z.string(),
  routeLongName: z.string().optional(),
  color: z.string().optional(),
  textColor: z.string().optional(),
  incoming: z.array(incomingBusSchema),
  layovers: z.array(layoverBusSchema),
  departed: z.array(departedBusSchema),
  interventions: z.array(interventionSchema),
});

/** Validates the REST and websocket snapshot representation. */
export const terminalSnapshotSchema = z.object({
  terminalId: z.string(),
  generatedAt: z.number(),
  serviceDayStartSeconds: z.number(),
  routes: z.array(routeStateSchema),
});

/** The websocket envelope; the array allows one broadcast to serve many terminals. */
export const wsSnapshotMessageSchema = z.object({
  type: z.literal('snapshots'),
  snapshots: z.array(terminalSnapshotSchema),
});

/** Health metadata used to distinguish a healthy process from fresh realtime data. */
export const healthSchema = z.object({
  ok: z.boolean(),
  lastRefreshAt: z.number().nullable(),
  staticLoadedAt: z.number().nullable(),
});

/** The terminal index plus route-to-terminal grouping used by the landing page. */
export const terminalsResponseSchema = z.object({
  terminals: z.array(terminalSchema),
  routes: z.array(z.object({
    routeId: z.string(),
    shortName: z.string(),
    longName: z.string().optional(),
    color: z.string().optional(),
    textColor: z.string().optional(),
    terminalIds: z.array(z.string()),
  })),
});

/** Minimal acknowledgement returned after requesting a static GTFS reload. */
export const staticReloadSchema = z.object({ ok: z.boolean() });
