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
  /** Compass bearing reported by the vehicle (degrees clockwise from north), when the feed supplies it. */
  bearing?: number;
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
  /** True while the vehicle is inside the arrival geofence but dwell is not confirmed yet. */
  arrivalPending?: boolean;
  /** True while a laid-over vehicle has crossed the departure trigger but lacks confirmation. */
  departurePending?: boolean;
  expectedDeparture: number;
  predictedDeparture: number;
  countdownSeconds: number;
  /** Seconds past the expected departure while still laying over; omitted until actually overdue. */
  overdueSeconds?: number;
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
  | 'completed'
  /** System action: a later refresh revised the hold values while the suggestion was pending. */
  | 'updated';

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

/**
 * Read-only debug map view of one terminal. Statuses are derived from the existing snapshot:
 * RouteState.incoming = inbound, a LayoverBus with arrivalPending = arriving, a LayoverBus with
 * neither pending flag = laying over, a LayoverBus with departurePending = departing, and
 * RouteState.departed = departed.
 */
export type VehicleMapStatus = 'inbound' | 'arriving' | 'laying_over' | 'departing' | 'departed';

/** A geofence circle the engine arms around a terminal stop, mirroring engine/recordFacts. */
export interface TerminalMapBuffer {
  stopId: string;
  lat: number;
  lon: number;
  radiusMeters: number;
  kind: 'arrival' | 'movement' | 'departure';
}

/** A terminal stop projected onto the debug map. */
export interface TerminalMapStop {
  stopId: string;
  name: string;
  lat: number;
  lon: number;
}

/** A color-coded, labeled arrow for one live vehicle on the debug map. */
export interface VehicleMapMarker {
  vehicleId?: string;
  tripId: string;
  routeShortName: string;
  routeColor?: string;
  status: VehicleMapStatus;
  lat: number;
  lon: number;
  /** Clockwise degrees from north; points toward the terminal for inbound/arriving/laying-over. */
  headingDegrees?: number;
  label: string;
  etaSeconds?: number;
}

/** Point-in-time debug map payload for one terminal. */
export interface TerminalMapSnapshot {
  terminalId: string;
  terminalName: string;
  generatedAt: number;        // unix seconds
  center: { lat: number; lon: number };
  buffers: TerminalMapBuffer[];
  stops: TerminalMapStop[];
  vehicles: VehicleMapMarker[];
}

/** Runtime configuration shared by the settings page and configuration API. */
export interface AppConfig {
  realtime: {
    tripUpdatesUrl: string;
    vehiclePositionsUrl?: string;
    apiKey?: string;
  };
  staticGtfsUrl: string;
  /** IANA timezone the GTFS agency schedules against; all service-day math is evaluated here
   *  instead of the server's local zone so a UTC cloud host cannot shift the whole schedule. */
  agencyTimezone: string;
  refreshIntervalSeconds: number;
  staticRefreshHours: number;
  minRestMinutes: number;
  maxHoldMinutes: number;
  leadTimeMinutes: number;
  lookaheadMinutes: number;
  terminals: Terminal[];
  /** Radius (meters) around a terminal stop within which a parked bus is counted as arrived. */
  arrivalRadiusMeters?: number;
  /** Additional meters tolerated while an arrival candidate moves from the inbound stop into the
   *  layover bay; departure uses the separate departureTriggerMeters setting. */
  terminalMovementMeters?: number;
  /** Displacement (meters) between polls that still counts as "parked" for arrival/departure arms. */
  stationaryDisplacementMeters?: number;
  /** Consecutive parked polls required before a proximity arm becomes a committed arrival fact. */
  confirmPings?: number;
  /** Consecutive moving/outside-buffer polls required before a layover becomes a committed departure. */
  departPings?: number;
  /** Grace (seconds) after the scheduled arrival before the scheduled-arm fallback fires. */
  scheduleArmGraceSeconds?: number;
  /** Maximum age of a VP sample that may create a new transition fact. */
  vehiclePositionMaxAgeSeconds?: number;
  /** Distance beyond the outbound first stop that starts departure confirmation. */
  departureTriggerMeters?: number;
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
  agencyTimezone: z.string().min(1).max(50).default('America/Chicago'),
  refreshIntervalSeconds: z.number().int().min(5).max(3600),
  staticRefreshHours: z.number().int().min(0).max(720),
  minRestMinutes: z.number().int().min(0).max(600),
  maxHoldMinutes: z.number().int().min(0).max(600),
  leadTimeMinutes: z.number().int().min(0).max(600),
  lookaheadMinutes: z.number().int().min(5).max(1440),
  terminals: z.array(terminalSchema),
  arrivalRadiusMeters: z.number().int().min(0).max(5000).optional(),
  terminalMovementMeters: z.number().int().min(0).max(5000).optional(),
  stationaryDisplacementMeters: z.number().int().min(0).max(1000).optional(),
  confirmPings: z.number().int().min(1).max(30).optional(),
  departPings: z.number().int().min(1).max(30).optional(),
  scheduleArmGraceSeconds: z.number().int().min(0).max(3600).optional(),
  vehiclePositionMaxAgeSeconds: z.number().int().min(10).max(3600).optional(),
  departureTriggerMeters: z.number().int().min(0).max(5000).optional(),
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
  arrivalPending: z.boolean().optional(),
  departurePending: z.boolean().optional(),
  expectedDeparture: z.number(),
  predictedDeparture: z.number(),
  countdownSeconds: z.number(),
  overdueSeconds: z.number().optional(),
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

const terminalMapBufferSchema = z.object({
  stopId: z.string(),
  lat: z.number(),
  lon: z.number(),
  radiusMeters: z.number(),
  kind: z.enum(['arrival', 'movement', 'departure']),
});

const terminalMapStopSchema = z.object({
  stopId: z.string(),
  name: z.string(),
  lat: z.number(),
  lon: z.number(),
});

const vehicleMapMarkerSchema = z.object({
  vehicleId: z.string().optional(),
  tripId: z.string(),
  routeShortName: z.string(),
  routeColor: z.string().optional(),
  status: z.enum(['inbound', 'arriving', 'laying_over', 'departing', 'departed']),
  lat: z.number(),
  lon: z.number(),
  headingDegrees: z.number().optional(),
  label: z.string(),
  etaSeconds: z.number().optional(),
});

/** Validates the read-only debug map payload served by GET /api/terminals/:id/map. */
export const terminalMapSnapshotSchema = z.object({
  terminalId: z.string(),
  terminalName: z.string(),
  generatedAt: z.number(),
  center: z.object({ lat: z.number(), lon: z.number() }),
  buffers: z.array(terminalMapBufferSchema),
  stops: z.array(terminalMapStopSchema),
  vehicles: z.array(vehicleMapMarkerSchema),
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
  ready: z.boolean().optional(),
  phase: z.enum(['starting', 'loading_static', 'ready', 'refreshing', 'error']).optional(),
  staticLoading: z.boolean().optional(),
  refreshInFlight: z.boolean().optional(),
  startupError: z.string().nullable().optional(),
  lastRefreshError: z.string().nullable().optional(),
  lastStaticLoadDurationMs: z.number().nullable().optional(),
  lastRefreshDurationMs: z.number().nullable().optional(),
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

// --- Vehicle detail card + block strip (read-only projections of data the server already holds) ---

/** A scheduled or realtime-augmented stop the selected vehicle will serve next. The TU
 * prediction window is the source of upcoming stops, with scheduled times filling gaps only
 * (see FEATURE_VEHICLE_CARD.md). */
export interface UpcomingStop {
  stopId: string;
  stopName: string;
  stopSequence: number;
  scheduled: number;        // service-day seconds
  predicted?: number;       // present only when the feed supplied timing
  source: 'scheduled' | 'predicted';
  /** Map-only coordinates; the vehicle card mini map plots upcoming stops as filled dots. */
  lat?: number;
  lon?: number;
}

/** A stop already behind the vehicle, rendered as a hollow dot on the mini map. */
export interface PassedStop {
  stopId: string;
  stopName: string;
  stopSequence: number;
  lat?: number;
  lon?: number;
}

/** Point-in-time read-only detail for one selected vehicle card at a terminal. Built from
 * latestRt plus the cached snapshot; it never triggers a feed fetch or engine refresh. */
export interface VehicleDetail {
  terminalId: string;
  tripId: string;            // the run the card represents
  blockId?: string;
  vehicleId?: string;
  routeId: string;
  routeShortName: string;
  color?: string;            // GTFS route colors, passed through
  textColor?: string;
  destination: string;       // trip's last stop name; primary label
  directionId?: number;      // UI renders a glyph, never "0"/"1" as text
  /** Live position: present only when the feed has coordinates for the vehicle. */
  position?: {
    lat: number;
    lon: number;
    headingDegrees?: number; // prefer feed bearing, else implied toward/away
    observedAt: number;      // epoch seconds of the VP sample
    ageSeconds: number;      // > vehiclePositionMaxAgeSeconds => UI greys the marker
  };
  status: 'incoming' | 'layover' | 'departed';
  hold?: { holdSeconds: number; effectiveDeparture: number; reason: string };
  overdueSeconds?: number;
  arrivalSource?: 'observed' | 'estimated';
  nextTripId?: string;       // block successor (97% accurate pre-flip)
  nextTripDestination?: string;
  /** Stops of the trip the vehicle currently operates: for an incoming card that is the inbound
   *  leg the bus is riding (mid-inbound), for layover/departed cards the run itself. */
  upcomingStops: UpcomingStop[];
  passedCount: number;       // stops of the current trip already behind the bus
  /** Map-only: stops behind the bus, rendered hollow on the mini map. */
  passedStops?: PassedStop[];
  terminalStop?: { stopId: string; stopName: string; lat?: number; lon?: number };
}

/** One block-chain trip rendered as a segment on the block strip. */
export interface BlockTrip {
  tripId: string;            // internal; UI must not display it as the label
  routeId: string;
  routeShortName: string;
  color?: string;
  textColor?: string;
  directionId?: number;
  destination: string;       // last stop name; primary label
  start: number;             // service-day seconds (first departure)
  end: number;               // service-day seconds (last arrival)
  state: 'past' | 'current' | 'future';   // versus the request's nowSvc
  departedSeconds?: number;  // observed departure fact when recorded (ledger)
  held?: boolean;            // departure happened under an applied hold
}

/** The horizontal timeline of one block for the active service date. */
export interface BlockTimeline {
  blockId: string;
  serviceDate: string;
  nowSvc: number;
  trips: BlockTrip[];        // ordered by block seq
}

const upcomingStopSchema = z.object({
  stopId: z.string(),
  stopName: z.string(),
  stopSequence: z.number(),
  scheduled: z.number(),
  predicted: z.number().optional(),
  source: z.enum(['scheduled', 'predicted']),
  lat: z.number().optional(),
  lon: z.number().optional(),
});

const passedStopSchema = z.object({
  stopId: z.string(),
  stopName: z.string(),
  stopSequence: z.number(),
  lat: z.number().optional(),
  lon: z.number().optional(),
});

/** Validates the read-only vehicle detail payload served by GET /api/terminals/:id/vehicles/:tripId. */
export const vehicleDetailSchema = z.object({
  terminalId: z.string(),
  tripId: z.string(),
  blockId: z.string().optional(),
  vehicleId: z.string().optional(),
  routeId: z.string(),
  routeShortName: z.string(),
  color: z.string().optional(),
  textColor: z.string().optional(),
  destination: z.string(),
  directionId: z.number().optional(),
  position: z.object({
    lat: z.number(),
    lon: z.number(),
    headingDegrees: z.number().optional(),
    observedAt: z.number(),
    ageSeconds: z.number(),
  }).optional(),
  status: z.enum(['incoming', 'layover', 'departed']),
  hold: holdOverrideSchema.optional(),
  overdueSeconds: z.number().optional(),
  arrivalSource: z.enum(['observed', 'estimated']).optional(),
  nextTripId: z.string().optional(),
  nextTripDestination: z.string().optional(),
  upcomingStops: z.array(upcomingStopSchema),
  passedCount: z.number(),
  passedStops: z.array(passedStopSchema).optional(),
  terminalStop: z.object({
    stopId: z.string(),
    stopName: z.string(),
    lat: z.number().optional(),
    lon: z.number().optional(),
  }).optional(),
});

const blockTripSchema = z.object({
  tripId: z.string(),
  routeId: z.string(),
  routeShortName: z.string(),
  color: z.string().optional(),
  textColor: z.string().optional(),
  directionId: z.number().optional(),
  destination: z.string(),
  start: z.number(),
  end: z.number(),
  state: z.enum(['past', 'current', 'future']),
  departedSeconds: z.number().optional(),
  held: z.boolean().optional(),
});

/** Validates the block timeline payload served by GET /api/blocks/:blockId. */
export const blockTimelineSchema = z.object({
  blockId: z.string(),
  serviceDate: z.string(),
  nowSvc: z.number(),
  trips: z.array(blockTripSchema),
});
