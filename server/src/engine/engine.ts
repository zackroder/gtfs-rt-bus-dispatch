import type { Database } from 'better-sqlite3';
import type {
  AppConfig,
  DepartedBus,
  IncomingBus,
  LayoverBus,
  RouteState,
  Terminal,
  TerminalMapBuffer,
  TerminalMapSnapshot,
  TerminalMapStop,
  TerminalSnapshot,
  VehicleMapMarker,
  VehicleMapStatus,
  VehiclePositionInfo,
} from '../../../shared/types';
import type { RealtimeSnapshot } from '../providers/types';
import { InterventionStore } from '../db/interventions';
import { prepared } from '../db/prepare';
import { activeServiceDate, activeServiceIds, getServiceDayStart, nowServiceSeconds, unixToServiceSeconds } from '../gtfs/time';
import {
  buildBlockChains,
  buildDepartures,
  buildTripEnds,
  type BlockChains,
  type ArrivalAtStop,
  type FactSource,
  type FactEvidence,
  type OutboundDeparture,
  type RunRecord,
  type TripEnd,
  type VehicleTerminalState,
  vehicleTerminalKey,
} from './headway';
import { decideTriplets, suggestionExpiresAt } from './dispatch';
import { outboundRoutesAtTerminal, routeStyle, type RouteStyle } from './terminal';
import { bearingDegrees, distanceMeters, distanceToStopMeters, nearestStopMeters, stopCoordinates, type GeoPoint } from './geometry';

// Engine owns the cross-refresh ledger: realtime snapshots are transient, while observed
// VP facts and approved interventions must survive feed gaps and process restarts.
const RECENT_DEPARTURE_SECONDS = 30 * 60;

interface RefreshContext {
  rt: RealtimeSnapshot;
  nowSvc: number;
  activeServiceIds: Set<string>;
  lookaheadSeconds: number;
  minRestSeconds: number;
  serviceDayStartSeconds: number;
  generatedAt: number;
  serviceDate: string;
  vpCurrentStop: Map<string, string>;
  tripUpdatesById: Map<string, RealtimeSnapshot['tripUpdates'][number]>;
  arrivalCache: Map<string, ArrivalAtStop>;
  // Per-vehicle terminal posture from the geometric fact pass, for layover classification.
  vpTerminalState: Map<string, VehicleTerminalState>;
}

export interface VehiclePositionDiagnostic {
  vehicleId: string;
  tripId?: string;
  previousTripId?: string;
  stopId?: string;
  currentStopSequence?: number;
  observationTimestamp: number;
  ageSeconds: number;
  matchedTrip: boolean;
  firstStopId?: string;
  firstStopSequence?: number;
  lastStopId?: string;
  lastStopSequence?: number;
  atLastStop: boolean;
  pastFirstStop: boolean;
  tripChanged: boolean;
  arrivalCandidateTripId?: string;
  departureCandidateTripId?: string;
  recordedArrival: boolean;
  recordedDeparture: boolean;
  // Geometric transition diagnostics.
  distToTerminalM?: number;
  inTerminalBuffer: boolean;
  parked: boolean;
  reasons: string[];
}

export interface FactEventDiagnostic {
  action: 'arrival' | 'departure';
  tripId: string;
  vehicleId?: string;
  at: number;
  generatedAt: number;
  source: FactSource;
  evidence: FactEvidence;
}

// Per-vehicle transition state held across refreshes. Only one arm and one layover
// exist per vehicle at a time; committed facts live in the trip-keyed ledger.
interface VehicleTrack {
  tripId?: string;
  lat?: number;
  lon?: number;
  observedAtSvc?: number;
  // VP timestamps are monotonic per vehicle. Refresh cadence and provider caching must not
  // turn one observation into multiple dwell or departure samples.
  lastVpTimestamp?: number;
  // Arrival arm: candidate outbound trip + the first qualifying parked ping time.
  parkedStreak: number;
  armTripId?: string;
  armAtSvc?: number;
  // Committed layover: the outbound trip the vehicle is resting for, and its anchor stop.
  layoverTripId?: string;
  layoverAnchorStopId?: string;
  // Departure arm: first ping where the vehicle left the terminal buffer.
  departStreak: number;
  departAtSvc?: number;
}

export class Engine {
  private ledger = new Map<string, RunRecord>();
  private vehicleTracks = new Map<string, VehicleTrack>();
  private blockChainsCache?: BlockChains;
  private blockChainsCacheKey?: string;
  private tripEndsCache?: Map<string, TripEnd>;
  private stopNamesCache?: Map<string, string>;
  private stopCoordsCache?: Map<string, GeoPoint>;
  private vehicleStopCache = new Map<string, string | undefined>();
  // Route display metadata is static per feed load; the refresh loop reads it per route.
  private routeStylesCache = new Map<string, RouteStyle>();
  private currentServiceDate?: string;
  private interventions: InterventionStore;
  private vpDiagnostics: VehiclePositionDiagnostic[] = [];
  private factEvents: FactEventDiagnostic[] = [];

  constructor(
    private db: Database,
    private getConfig: () => AppConfig,
    interventions?: InterventionStore,
  ) {
    this.interventions = interventions ?? new InterventionStore(db);
  }

  // Clear schedule-derived and observed state when the static feed is replaced.
  invalidateStaticCaches(): void {
    // Static reload invalidates every schedule-derived cache and cancels recommendations whose
    // trip identities may no longer refer to the loaded feed.
    this.blockChainsCache = undefined;
    this.blockChainsCacheKey = undefined;
    this.tripEndsCache = undefined;
    this.stopNamesCache = undefined;
    this.stopCoordsCache = undefined;
    this.vehicleStopCache.clear();
    this.routeStylesCache.clear();
    this.ledger.clear();
    this.vehicleTracks.clear();
    this.currentServiceDate = undefined;
    this.interventions.cancelForStaticReload(Math.floor(Date.now() / 1000));
    this.db.prepare(`DELETE FROM run_facts`).run();
  }

  private blockChains(activeIds?: Set<string>): BlockChains {
    const key = activeIds ? Array.from(activeIds).sort().join('|') : '*';
    if (!this.blockChainsCache || this.blockChainsCacheKey !== key) {
      this.blockChainsCache = buildBlockChains(this.db, activeIds);
      this.blockChainsCacheKey = key;
    }
    return this.blockChainsCache;
  }

  private tripEnds(): Map<string, TripEnd> {
    if (!this.tripEndsCache) this.tripEndsCache = buildTripEnds(this.db);
    return this.tripEndsCache;
  }

  private stopNames(): Map<string, string> {
    if (!this.stopNamesCache) {
      const rows = this.db
        .prepare('SELECT stop_id, stop_name FROM stops')
        .all() as Array<{ stop_id: string; stop_name: string }>;
      this.stopNamesCache = new Map(rows.map((r) => [r.stop_id, r.stop_name]));
    }
    return this.stopNamesCache;
  }

  private stopCoords(): Map<string, GeoPoint> {
    if (!this.stopCoordsCache) this.stopCoordsCache = stopCoordinates(this.db);
    return this.stopCoordsCache;
  }

  private routeStyleFor(routeId: string): RouteStyle {
    let style = this.routeStylesCache.get(routeId);
    if (!style) {
      style = routeStyle(this.db, routeId);
      this.routeStylesCache.set(routeId, style);
    }
    return style;
  }

  // Resolve the proximity radius for a terminal stop, preferring a per-terminal override.
  private terminalRadiusMeters(stopId: string | undefined): number {
    const config = this.getConfig();
    if (stopId !== undefined) {
      const terminal = config.terminals.find((t) => t.stopIds.includes(stopId));
      if (terminal?.radiusMeters !== undefined) return terminal.radiusMeters;
    }
    return config.arrivalRadiusMeters ?? 150;
  }

  private vehicleCurrentStop(vp: VehiclePositionInfo): string | undefined {
    let stopId = vp.stopId;
    if (!stopId && vp.tripId && vp.currentStopSequence !== undefined) {
      // Some feeds provide only a sequence; resolve it through static stop_times and cache the name.
      const cacheKey = `${vp.tripId}:${vp.currentStopSequence}`;
      if (this.vehicleStopCache.has(cacheKey)) return this.vehicleStopCache.get(cacheKey);
      const row = prepared(
        this.db,
        'SELECT stop_id FROM stop_times WHERE trip_id = ? AND stop_sequence = ?',
      ).get(vp.tripId, vp.currentStopSequence) as { stop_id?: string } | undefined;
      stopId = row?.stop_id;
      const name = stopId ? this.stopNames().get(stopId) : undefined;
      this.vehicleStopCache.set(cacheKey, name);
      return name;
    }
    return stopId ? this.stopNames().get(stopId) : undefined;
  }

  // These snapshots are intentionally in memory: they describe the last feed poll for diagnosis,
  // while durable arrival/departure facts remain in run_facts.
  getVehiclePositionDiagnostics(): VehiclePositionDiagnostic[] {
    return this.vpDiagnostics.map((diagnostic) => ({ ...diagnostic, reasons: [...diagnostic.reasons] }));
  }

  getFactEventDiagnostics(): FactEventDiagnostic[] {
    return this.factEvents.map((event) => ({ ...event }));
  }

  // Convert one realtime poll into snapshots for the requested terminals.
  refresh(rt: RealtimeSnapshot, now: Date = new Date(), terminalIds?: Set<string>): TerminalSnapshot[] {
    const config = this.getConfig();
    // All schedule/realtime clock conversions happen in the agency's timezone, never the
    // server's local zone, so the math is identical on a Chicago workstation or a UTC host.
    const timeZone = config.agencyTimezone;
    const serviceDayStartSeconds = getServiceDayStart(this.db);
    const nowSvc = nowServiceSeconds(now, serviceDayStartSeconds, timeZone);
    const activeDate = activeServiceDate(now, serviceDayStartSeconds, timeZone);
    if (this.currentServiceDate !== activeDate) {
      // A service-day boundary starts a fresh in-memory ledger, then restores only facts persisted
      // for the new date so overnight operation cannot mix runs from adjacent dates.
      this.ledger.clear();
      this.vehicleTracks.clear();
      this.currentServiceDate = activeDate;
      this.loadRunFacts(activeDate);
    }
    const generatedAt = Math.floor(now.getTime() / 1000);
    const activeIds = activeServiceIds(this.db, activeDate);
    // Queue expiry, applied holds, and fact recording all use the same service-date scope as schedule queries.
    this.interventions.expirePending(activeDate, generatedAt);
    const currentInterventions = this.interventions.listForServiceDate(activeDate);
    const holdInterventions = new Map(
      currentInterventions
        .filter((intervention) => intervention.status === 'applied' || intervention.status === 'completed')
        .map((intervention) => [intervention.tripId, intervention]),
    );
    for (const [tripId, record] of this.ledger) {
      if (record.hold && !holdInterventions.has(tripId)) delete record.hold;
    }
    for (const intervention of currentInterventions.filter((item) => item.status === 'applied')) {
      const record = this.ledger.get(intervention.tripId) ?? {};
      record.hold = {
        holdSeconds: intervention.holdSeconds,
        effectiveDeparture: intervention.until ?? 0,
        reason: intervention.reason,
      };
      this.ledger.set(intervention.tripId, record);
    }
    const vpTerminalState = new Map<string, VehicleTerminalState>();
    this.recordFacts(
      rt,
      nowSvc,
      serviceDayStartSeconds,
      generatedAt,
      activeDate,
      this.blockChains(activeIds),
      config.terminals,
      vpTerminalState,
    );

    const vpCurrentStop = new Map<string, string>();
    for (const vp of rt.vehiclePositions) {
      const name = this.vehicleCurrentStop(vp);
      if (name) vpCurrentStop.set(vp.vehicleId, name);
    }
    const ctx: RefreshContext = {
      rt,
      nowSvc,
      activeServiceIds: activeIds,
      lookaheadSeconds: config.lookaheadMinutes * 60,
      minRestSeconds: config.minRestMinutes * 60,
      serviceDayStartSeconds,
      generatedAt,
      serviceDate: activeDate,
      vpCurrentStop,
      tripUpdatesById: new Map(rt.tripUpdates.map((update) => [update.tripId, update])),
      arrivalCache: new Map(),
      vpTerminalState,
    };

    const wanted = terminalIds ?? new Set(config.terminals.map((t) => t.id));
    // Facts are recorded before filtering so an unviewed terminal cannot cause a missed departure.
    const blockChains = this.blockChains(activeIds);
    const snapshots: TerminalSnapshot[] = [];
    for (const terminal of config.terminals) {
      if (!wanted.has(terminal.id)) continue;
      const routes = this.buildRouteStates(terminal, ctx, blockChains);
      snapshots.push({
        terminalId: terminal.id,
        generatedAt: ctx.generatedAt,
        serviceDayStartSeconds: ctx.serviceDayStartSeconds,
        routes,
      });
    }
    return snapshots;
  }

  private recordArrival(
    tripId: string,
    at: number,
    source: FactSource,
    evidence: FactEvidence,
    generatedAt: number,
    serviceDate: string,
    vehicleId?: string,
  ): boolean {
    const record = this.ledger.get(tripId) ?? {};
    if (record.arrivalSource === 'vp') {
      // A later trip flip confirms an earlier geometric fact without replacing its physical event
      // time. Keep the strongest evidence in memory for diagnostics and the current snapshot.
      if (evidence === 'trip_flip' && record.arrivalEvidence !== 'trip_flip') {
        record.arrivalEvidence = evidence;
        this.ledger.set(tripId, record);
      }
      return false;
    }
    if (record.arrivalSeconds !== undefined && source === 'tu') return false;
    if (record.arrivalSeconds === at && record.arrivalSource === source) return false;
    record.arrivalSeconds = at;
    record.arrivalSource = source;
    record.arrivalEvidence = evidence;
    this.ledger.set(tripId, record);
    this.persistRunFact(serviceDate, tripId, record, generatedAt);
    this.recordFactEvent({ action: 'arrival', tripId, vehicleId, at, generatedAt, source, evidence });
    return true;
  }

  private recordDeparture(
    tripId: string,
    at: number,
    source: FactSource,
    evidence: FactEvidence,
    generatedAt: number,
    serviceDate: string,
    vehicleId?: string,
  ): boolean {
    const record = this.ledger.get(tripId) ?? {};
    if (record.departureSource === 'vp') {
      if (evidence === 'trip_flip' && record.departureEvidence !== 'trip_flip') {
        record.departureEvidence = evidence;
        this.ledger.set(tripId, record);
      }
      return false;
    }
    // Apply the same VP-over-TU precedence to departures and resolve any hold when the run leaves.
    if (record.departureSeconds !== undefined && source === 'tu') return false;
    if (record.departureSeconds === at && record.departureSource === source) return false;
    record.departureSeconds = at;
    record.departureSource = source;
    record.departureEvidence = evidence;
    this.ledger.set(tripId, record);
    this.persistRunFact(serviceDate, tripId, record, generatedAt);
    this.interventions.completeTrip(serviceDate, tripId, generatedAt);
    this.recordFactEvent({ action: 'departure', tripId, vehicleId, at, generatedAt, source, evidence });
    return true;
  }

  private recordFactEvent(event: FactEventDiagnostic): void {
    this.factEvents.push(event);
    if (this.factEvents.length > 100) this.factEvents.shift();
  }

  // Append observed arrival/departure facts to the run_events audit log, carrying the
  // terminal/route context and the dispatch state (classification, EDT) at the moment the fact
  // was rendered. UNIQUE(service_date, trip_id, event_type, value_seconds) keeps the log
  // idempotent across refreshes while preserving every distinct recorded value.
  private recordRunEvents(
    departure: OutboundDeparture,
    terminalId: string,
    routeId: string,
    ctx: RefreshContext,
  ): void {
    const record = this.ledger.get(departure.tripId);
    // Called per departure per refresh; the statement is memoized rather than re-prepared.
    const insert = prepared(
      this.db,
      `INSERT OR IGNORE INTO run_events
          (service_date, event_type, trip_id, vehicle_id, terminal_id, route_id, source,
            evidence, value_seconds, generated_at, classification, edt_seconds,
            scheduled_departure, scheduled_arrival, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const createdAt = Math.floor(Date.now() / 1000);
    if (departure.terminalArrival !== undefined && record?.arrivalSource !== undefined) {
      insert.run(
        ctx.serviceDate, 'arrival', departure.tripId, departure.vehicleId ?? null,
        terminalId, routeId, record.arrivalSource, record.arrivalEvidence ?? null, departure.terminalArrival,
        ctx.generatedAt, departure.state, departure.edt,
        departure.scheduledDeparture, departure.scheduledArrival, createdAt,
      );
    }
    if (departure.departedSeconds !== undefined && record?.departureSource !== undefined) {
      insert.run(
        ctx.serviceDate, 'departure', departure.tripId, departure.vehicleId ?? null,
        terminalId, routeId, record.departureSource, record.departureEvidence ?? null, departure.departedSeconds,
        ctx.generatedAt, departure.state, departure.edt,
        departure.scheduledDeparture, departure.scheduledArrival, createdAt,
      );
    }
  }

  private loadRunFacts(serviceDate: string): void {
    const rows = this.db
      .prepare(
        `SELECT trip_id, arrival_seconds, departure_seconds
         FROM run_facts WHERE service_date = ?`,
      )
      .all(serviceDate) as Array<{
      trip_id: string;
      arrival_seconds: number | null;
      departure_seconds: number | null;
    }>;
    for (const row of rows) {
      // Persisted facts originate from VP observations, so restored records retain that authority.
      this.ledger.set(row.trip_id, {
        arrivalSeconds: row.arrival_seconds ?? undefined,
        arrivalSource: row.arrival_seconds !== null ? 'vp' : undefined,
        arrivalEvidence: row.arrival_seconds !== null ? 'restored_vp' : undefined,
        departureSeconds: row.departure_seconds ?? undefined,
        departureSource: row.departure_seconds !== null ? 'vp' : undefined,
        departureEvidence: row.departure_seconds !== null ? 'restored_vp' : undefined,
      });
    }
  }

  private persistRunFact(serviceDate: string, tripId: string, record: RunRecord, updatedAt: number): void {
    this.db
      .prepare(
        `INSERT INTO run_facts
         (service_date, trip_id, arrival_seconds, departure_seconds, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(service_date, trip_id) DO UPDATE SET
           arrival_seconds = excluded.arrival_seconds,
           departure_seconds = excluded.departure_seconds,
           updated_at = excluded.updated_at`,
      )
      .run(serviceDate, tripId, record.arrivalSeconds ?? null, record.departureSeconds ?? null, updatedAt);
  }

  // Return the outbound trip a parked vehicle should be forming: its own trip when that
  // trip starts at a terminal (the flip already happened), else the block successor, then
  // the TU-lookahead assignment. Static block chains predict the re-key target ~97% of the
  // time, and TU assigns the vehicle to that same trip before the VP flips, so either is safe.
  private arrivalTargetFor(
    tripId: string,
    vehicleId: string,
    rt: RealtimeSnapshot,
    chains: BlockChains,
    terminal: Terminal,
  ): string | undefined {
    const ends = this.tripEnds();
    const current = ends.get(tripId);
    if (!current) return undefined;
    if (terminal.stopIds.includes(current.firstStopId)) return tripId;

    const next = chains.nextTrip.get(tripId);
    const nextEnd = next ? ends.get(next) : undefined;
    if (nextEnd && terminal.stopIds.includes(nextEnd.firstStopId)) return next;

    // CTA may publish both the current inbound and upcoming outbound TU for one vehicle.
    // Select the TU whose first stop belongs to this terminal instead of relying on entity order.
    const assigned = rt.tripUpdates.find((u) => {
      if (u.vehicleId !== vehicleId) return false;
      const end = ends.get(u.tripId);
      return end !== undefined && terminal.stopIds.includes(end.firstStopId);
    });
    if (assigned) return assigned.tripId;
    return undefined;
  }

  private recordFacts(
    rt: RealtimeSnapshot,
    nowSvc: number,
    serviceDayStartSeconds: number,
    generatedAt: number,
    serviceDate: string,
    chains: BlockChains,
    terminals: readonly Terminal[],
    vpTerminalState: Map<string, VehicleTerminalState>,
  ): void {
    const config = this.getConfig();
    const timeZone = config.agencyTimezone;
    const ends = this.tripEnds();
    this.vpDiagnostics = [];
    const stationaryMeters = config.stationaryDisplacementMeters ?? 20;
    const confirmPings = config.confirmPings ?? 2;
    const departPings = config.departPings ?? 2;
    const maxVpAgeSeconds = config.vehiclePositionMaxAgeSeconds ?? 300;
    const departureTriggerMeters = config.departureTriggerMeters ?? 75;
    // Movement allowance applies to the arrival candidate: it may move from the inbound stop into
    // the layover bay without aborting. A committed layover uses departureTriggerMeters instead.
    const movementMeters = config.terminalMovementMeters ?? 75;

    const terminalStopIds = new Set(terminals.flatMap((terminal) => terminal.stopIds));
    for (const vp of rt.vehiclePositions) {
      const vpSeconds = vp.timestamp > generatedAt
        ? nowSvc
        : unixToServiceSeconds(vp.timestamp, serviceDayStartSeconds, timeZone);
      // Future-dated provider timestamps cannot describe an event after the current refresh.
      const track = this.vehicleTracks.get(vp.vehicleId) ?? {
        parkedStreak: 0,
        departStreak: 0,
      };
      const observationAge = generatedAt - vp.timestamp;
      const freshObservation = rt.vehiclePositionsFromCache !== true &&
        observationAge <= maxVpAgeSeconds &&
        (track.lastVpTimestamp === undefined || vp.timestamp > track.lastVpTimestamp);
      const point = vp.lat !== undefined && vp.lon !== undefined ? { lat: vp.lat, lon: vp.lon } : undefined;
      const displacementM =
        point && track.lat !== undefined && track.lon !== undefined
          ? distanceMeters(point, { lat: track.lat, lon: track.lon })
          : undefined;
      const tripChanged = freshObservation && track.tripId !== undefined &&
        vp.tripId !== undefined && track.tripId !== vp.tripId;

      const diagnostic: VehiclePositionDiagnostic = {
        vehicleId: vp.vehicleId,
        tripId: vp.tripId,
        previousTripId: track.tripId,
        stopId: vp.stopId,
        currentStopSequence: vp.currentStopSequence,
        observationTimestamp: vp.timestamp,
        ageSeconds: Math.max(0, generatedAt - vp.timestamp),
        matchedTrip: vp.tripId !== undefined && ends.has(vp.tripId),
        atLastStop: false,
        pastFirstStop: false,
        tripChanged,
        recordedArrival: false,
        recordedDeparture: false,
        inTerminalBuffer: false,
        parked: false,
        reasons: [],
      };
      if (!freshObservation) diagnostic.reasons.push(
        rt.vehiclePositionsFromCache === true
          ? 'cached_observation'
          : observationAge > maxVpAgeSeconds
            ? 'stale_observation'
            : 'duplicate_or_out_of_order',
      );
      if (!vp.tripId || !ends.has(vp.tripId)) {
        // A deadhead / non-revenue / first-of-block leg has no static trip, so we cannot resolve
        // its endpoint — but we can still record whether the vehicle is parked at a terminal from
        // pure geometry. That posture is what lets a TU assignment confirm a layover independent
        // of the inbound trip's identity.
        const nearest = nearestStopMeters(this.stopCoords(), Array.from(terminalStopIds), point);
        diagnostic.distToTerminalM = Number.isFinite(nearest.meters) ? Math.round(nearest.meters) : undefined;
        diagnostic.inTerminalBuffer = nearest.meters <= this.terminalRadiusMeters(nearest.stopId);
         diagnostic.parked =
           diagnostic.inTerminalBuffer && displacementM !== undefined && displacementM < stationaryMeters;
        diagnostic.reasons.push(!vp.tripId ? 'missing_trip_id' : 'trip_not_in_static_feed');
        this.vpDiagnostics.push(diagnostic);
        const nearestTerminal = terminals.find((terminal) => terminal.stopIds.includes(nearest.stopId ?? ''));
        if (nearestTerminal) {
          vpTerminalState.set(vehicleTerminalKey(vp.vehicleId, nearestTerminal.id), {
            terminalId: nearestTerminal.id,
            inBuffer: diagnostic.inTerminalBuffer,
            parked: diagnostic.parked,
            distToTerminalM: diagnostic.distToTerminalM,
            armTripId: track.armTripId,
            layoverTripId: track.layoverTripId,
            departurePending: track.layoverTripId !== undefined && track.departStreak > 0,
          });
        }
        // Keep the last accepted sample as the displacement baseline. A duplicate or older
        // observation may still describe current posture, but must not move that baseline backward.
        if (track.lastVpTimestamp === undefined || freshObservation) {
          track.tripId = vp.tripId ?? track.tripId;
          track.lat = point?.lat;
          track.lon = point?.lon;
          track.observedAtSvc = vpSeconds;
          track.lastVpTimestamp = Math.max(track.lastVpTimestamp ?? 0, vp.timestamp);
        }
        this.vehicleTracks.set(vp.vehicleId, track);
        continue;
      }

      const end = ends.get(vp.tripId)!;
      diagnostic.matchedTrip = true;
      diagnostic.firstStopId = end.firstStopId;
      diagnostic.firstStopSequence = end.firstStopSequence;
      diagnostic.lastStopId = end.lastStopId;
      diagnostic.lastStopSequence = end.lastStopSequence;

      // Trip re-key semantics follow the corrected model: flipping onto an outbound trip
      // confirms that trip's arrival/assignment. A re-key is not a departure signal because the
      // feed can change trips while the bus is still laying over at the terminal.
      if (tripChanged && track.tripId) {
        if (end.firstStopId && terminalStopIds.has(end.firstStopId)) {
          diagnostic.arrivalCandidateTripId = vp.tripId;
          diagnostic.recordedArrival = this.recordArrival(
            vp.tripId,
            track.armTripId === vp.tripId && track.armAtSvc !== undefined
              ? Math.min(track.armAtSvc, vpSeconds)
              : vpSeconds,
            'vp',
            'trip_flip',
            generatedAt,
            serviceDate,
            vp.vehicleId,
          );
          diagnostic.reasons.push('flip_in_arrival');
        }
        diagnostic.reasons.push(
          end.firstStopId && terminalStopIds.has(end.firstStopId)
            ? 'trip_changed_assignment_only'
            : 'trip_changed_no_terminal',
        );
      }

      // The terminal anchor is the static last stop of the current inbound trip. VP stop_id is not
      // used because the production feed omits it; coordinates provide the terminal proximity.
      const anchorStopId = end.lastStopId;
      const terminal = anchorStopId === undefined
        ? undefined
        : terminals.find((candidate) => candidate.stopIds.includes(anchorStopId));
      const inTerminal = terminal !== undefined;
      const distToTerminal = inTerminal && point
        ? distanceToStopMeters(this.stopCoords(), anchorStopId, point)
        : Infinity;
      const radius = this.terminalRadiusMeters(anchorStopId);
      const holdRadius = radius + movementMeters;
      diagnostic.distToTerminalM = Number.isFinite(distToTerminal) ? Math.round(distToTerminal) : undefined;
      // CTA's VP feed does not provide a usable stop_id. Terminal mechanics therefore rely only
      // on the current trip's static endpoint and the observed coordinates.
      diagnostic.inTerminalBuffer = inTerminal && distToTerminal <= radius;
      diagnostic.parked =
        diagnostic.inTerminalBuffer && displacementM !== undefined && displacementM < stationaryMeters;

      // Arrival arm: entering the endpoint radius starts a candidate, while confirmation requires
      // fresh low-displacement samples. The larger hold zone is hysteresis for a bus moving from
      // the stop to its layover position; movement there keeps the candidate alive but does not
      // count as dwell. The first entry timestamp remains the event time after confirmation.
      const inArrivalZone = inTerminal && distToTerminal <= radius;
      const inHoldZone = inTerminal && distToTerminal <= holdRadius;
      // The first coordinate sample has no prior displacement to compare, so it can start the
      // dwell streak; subsequent samples must prove low movement. A missing coordinate never does.
      const stationaryInHoldZone = inHoldZone && point !== undefined &&
        (displacementM === undefined || displacementM < stationaryMeters);
      if (inArrivalZone || (track.armTripId !== undefined && inHoldZone)) {
        const target = terminal ? this.arrivalTargetFor(vp.tripId, vp.vehicleId, rt, chains, terminal) : undefined;
        if (target) {
          const alreadyArrived = this.ledger.get(target)?.arrivalSeconds !== undefined;
          if (!alreadyArrived && freshObservation) {
            if (track.armTripId !== undefined && track.armTripId !== target) {
              track.parkedStreak = 0;
              track.armAtSvc = undefined;
              track.armTripId = undefined;
            }
            if (track.armTripId === undefined) {
              track.armAtSvc = vpSeconds;
              track.armTripId = target;
            }
            if (stationaryInHoldZone) {
              track.parkedStreak++;
            } else {
              // A bus can enter the radius and pull into its bay before it becomes still. Keep
              // the candidate, but require consecutive low-motion samples to confirm it.
              track.parkedStreak = 0;
            }
            if (track.parkedStreak >= confirmPings) {
              diagnostic.arrivalCandidateTripId = target;
              diagnostic.recordedArrival = this.recordArrival(
                target,
                track.armAtSvc ?? vpSeconds,
                'vp',
                'geofence_dwell',
                generatedAt,
                serviceDate,
                vp.vehicleId,
              );
              track.layoverTripId = target;
              track.layoverAnchorStopId = this.tripEnds().get(target)?.firstStopId;
              track.parkedStreak = 0;
              track.armTripId = undefined;
            } else {
              diagnostic.reasons.push(stationaryInHoldZone ? 'arrival_armed' : 'arrival_waiting_dwell');
            }
          } else {
            diagnostic.reasons.push('arrival_already_recorded');
          }
        } else {
          diagnostic.reasons.push('no_arrival_target');
        }
      } else if (diagnostic.parked) {
        diagnostic.reasons.push('parked_not_in_terminal_buffer');
      } else if (track.armTripId) {
        // Left the hold zone entirely: drop the pending arm so a bus that pulls out before the
        // arm latches does not linger as a would-be layover.
        diagnostic.reasons.push('left_hold_zone_abort');
        track.parkedStreak = 0;
        track.armTripId = undefined;
        track.armAtSvc = undefined;
      }

      // Position-based fallback: a vehicle first seen on an outbound trip beyond the tight
      // departure trigger is already away from the terminal, so recover the missed departure.
      // Once a layover is committed, the motion-confirmation path below owns this transition.
      if (end.firstStopId && terminalStopIds.has(end.firstStopId) && point && freshObservation) {
        const outDist = distanceToStopMeters(this.stopCoords(), end.firstStopId, point);
        if (outDist > departureTriggerMeters && track.layoverTripId !== vp.tripId) {
          diagnostic.departureCandidateTripId = vp.tripId;
          diagnostic.recordedDeparture = this.recordDeparture(
            vp.tripId,
            vpSeconds,
            'vp',
            'out_of_buffer',
            generatedAt,
            serviceDate,
            vp.vehicleId,
          ) || diagnostic.recordedDeparture;
          diagnostic.reasons.push('outbound_out_of_buffer');
          if (track.layoverTripId === vp.tripId) {
            track.layoverTripId = undefined;
            track.layoverAnchorStopId = undefined;
            track.departStreak = 0;
            track.departAtSvc = undefined;
          }
        }
      }

      // Layover departure by motion: a committed layover that moves beyond the outbound first-stop
      // trigger for departPings consecutive fresh pings is pulling out. The first qualifying ping
      // timestamps the fact; the pending state is exposed while confirmation is in progress.
      if (track.layoverTripId && track.layoverAnchorStopId && point && freshObservation) {
        const layoverDist = distanceToStopMeters(this.stopCoords(), track.layoverAnchorStopId, point);
        const beyondDepartureTrigger = layoverDist > departureTriggerMeters;
        const moving = displacementM !== undefined && displacementM >= stationaryMeters;
        if (beyondDepartureTrigger && moving) {
          if (track.departStreak === 0) track.departAtSvc = vpSeconds;
          track.departStreak++;
          if (track.departStreak >= departPings) {
            diagnostic.departureCandidateTripId = track.layoverTripId;
            diagnostic.recordedDeparture = this.recordDeparture(
              track.layoverTripId,
              track.departAtSvc ?? vpSeconds,
              'vp',
              'motion_exit',
              generatedAt,
              serviceDate,
              vp.vehicleId,
            ) || diagnostic.recordedDeparture;
            track.layoverTripId = undefined;
            track.layoverAnchorStopId = undefined;
            track.departStreak = 0;
            track.departAtSvc = undefined;
          } else {
            diagnostic.reasons.push('departure_armed');
          }
        } else {
          track.departStreak = 0;
          track.departAtSvc = undefined;
        }
      }

      if (!diagnostic.recordedArrival && !diagnostic.recordedDeparture && diagnostic.reasons.length === 0) {
        diagnostic.reasons.push('no_transition');
      }
      this.vpDiagnostics.push(diagnostic);

      const postureTerminal = terminal ?? terminals.find((candidate) =>
        candidate.stopIds.includes(track.layoverAnchorStopId ?? ''),
      );
      if (postureTerminal) {
        vpTerminalState.set(vehicleTerminalKey(vp.vehicleId, postureTerminal.id), {
          terminalId: postureTerminal.id,
          inBuffer: diagnostic.inTerminalBuffer,
          parked: diagnostic.parked,
          distToTerminalM: diagnostic.distToTerminalM,
          armTripId: track.armTripId,
          layoverTripId: track.layoverTripId,
          departurePending: track.layoverTripId !== undefined && track.departStreak > 0,
        });
      }

      if (track.lastVpTimestamp === undefined || freshObservation) {
        track.tripId = vp.tripId;
        track.lat = point?.lat;
        track.lon = point?.lon;
        track.observedAtSvc = vpSeconds;
        track.lastVpTimestamp = Math.max(track.lastVpTimestamp ?? 0, vp.timestamp);
      }
      this.vehicleTracks.set(vp.vehicleId, track);
    }

  }

  private buildRouteStates(
    terminal: Terminal,
    ctx: RefreshContext,
    blockChains: BlockChains,
  ): RouteState[] {
    const config = this.getConfig();
    const queueInterventions = this.interventions.listForTerminal(ctx.serviceDate, terminal.id);
    const configuredRouteIds =
      terminal.routeIds ??
      outboundRoutesAtTerminal(
        this.db,
        terminal.stopIds,
        ctx.activeServiceIds,
        ctx.nowSvc,
        ctx.nowSvc + ctx.lookaheadSeconds,
      );
    const routeIds = new Set([
      ...configuredRouteIds,
      ...queueInterventions.map((intervention) => intervention.routeId),
    ]);
    // Keep queued interventions visible even if a route temporarily falls outside the configured
    // lookahead, so operators can resolve durable work.
    const states: RouteState[] = [];
    for (const routeId of routeIds) {
      const departures = buildDepartures(this.db, {
        routeId,
        terminal,
        nowSvc: ctx.nowSvc,
        lookaheadSeconds: ctx.lookaheadSeconds,
        serviceDayStartSeconds: ctx.serviceDayStartSeconds,
        minRestSeconds: ctx.minRestSeconds,
        activeServiceIds: ctx.activeServiceIds,
        rt: ctx.rt,
        ledger: this.ledger,
        blockChains,
        tripUpdatesById: ctx.tripUpdatesById,
        arrivalCache: ctx.arrivalCache,
        vpTerminalState: ctx.vpTerminalState,
        scheduleArmGraceSeconds: config.scheduleArmGraceSeconds,
        agencyTimezone: config.agencyTimezone,
      });

      const decisions = decideTriplets(departures, {
        nowSvc: ctx.nowSvc,
        leadTimeSeconds: config.leadTimeMinutes * 60,
        maxHoldSeconds: config.maxHoldMinutes * 60,
        requireObservedArrival: true,
      });
      // Suggestions are persisted before the route response and reconciled on every refresh,
      // so a pending recommendation tracks the latest EDT while approval remains the only path
      // that applies a hold to the ledger.
      for (const decision of decisions) {
        this.interventions.refreshSuggestion({
          id: `hold:${ctx.serviceDate}:${terminal.id}:${routeId}:${decision.tripId}`,
          serviceDate: ctx.serviceDate,
          terminalId: terminal.id,
          routeId,
          rule: 'hold',
          tripId: decision.tripId,
          vehicleId: decision.vehicleId,
          leaderVehicleId: decision.leaderVehicleId,
          followerVehicleId: decision.followerVehicleId,
          holdSeconds: decision.holdSeconds,
          until: decision.until,
          reason: decision.reason,
          generatedAt: ctx.generatedAt,
          expiresAt: suggestionExpiresAt(decision.until, ctx.nowSvc, ctx.generatedAt),
        });
      }
      const interventions = this.interventions.listForRoute(ctx.serviceDate, terminal.id, routeId);

      const style = this.routeStyleFor(routeId);
      const shortName = style.shortName;
      const incoming: IncomingBus[] = [];
      const layovers: LayoverBus[] = [];
      const departed: DepartedBus[] = [];
      for (const departure of departures) {
        this.recordRunEvents(departure, terminal.id, routeId, ctx);
        if (departure.state === 'incoming') {
          incoming.push({
            routeId,
            routeShortName: shortName,
            tripId: departure.prevTripId ?? departure.tripId,
            vehicleId: departure.vehicleId,
            scheduledArrival: departure.scheduledArrival,
            predictedArrival: departure.predictedArrival,
            etaSeconds: Math.max(0, departure.predictedArrival - ctx.nowSvc),
            delaySeconds: departure.predictedArrival - departure.scheduledArrival,
            nextTripId: departure.tripId,
            nextDestination: this.tripEnds().get(departure.tripId)?.lastStopName ?? shortName,
            scheduledDeparture: departure.scheduledDeparture,
            expectedDeparture: departure.edt,
            restDelayed: departure.edt > departure.scheduledDeparture,
          });
        } else if (departure.state === 'layover') {
          const predictedDeparture = departure.hold
            ? departure.hold.effectiveDeparture
            : departure.edt;
          layovers.push({
            routeId,
            routeShortName: shortName,
            tripId: departure.tripId,
            vehicleId: departure.vehicleId,
            scheduledDeparture: departure.scheduledDeparture,
            scheduledArrival: departure.scheduledArrival,
            terminalArrival: departure.terminalArrival,
            terminalArrivalSource: departure.arrivalSource,
            arrivalPending: departure.arrivalPending,
            departurePending: departure.departurePending,
            expectedDeparture: departure.edt,
            predictedDeparture,
            countdownSeconds: predictedDeparture - ctx.nowSvc,
            overdueSeconds: departure.overdueSeconds,
            hold: departure.hold,
            restDelayed: departure.edt > departure.scheduledDeparture,
          });
        } else if (
          departure.state === 'departed' &&
          departure.departedSeconds !== undefined &&
          departure.departedSeconds >= ctx.nowSvc - RECENT_DEPARTURE_SECONDS
        ) {
          departed.push({
            routeId,
            routeShortName: shortName,
            tripId: departure.tripId,
            vehicleId: departure.vehicleId,
            headsign: this.tripEnds().get(departure.tripId)?.lastStopName ?? shortName,
            scheduledDeparture: departure.scheduledDeparture,
            departureSeconds: departure.departedSeconds,
            held: departure.hold !== undefined,
            currentStop: departure.vehicleId
              ? ctx.vpCurrentStop.get(departure.vehicleId)
              : undefined,
          });
        }
      }
      incoming.sort((a, b) => a.etaSeconds - b.etaSeconds);
      layovers.sort((a, b) => a.predictedDeparture - b.predictedDeparture);
      departed.sort((a, b) => b.departureSeconds - a.departureSeconds);

      states.push({
        routeId,
        routeShortName: shortName,
        routeLongName: style.longName,
        color: style.color,
        textColor: style.textColor,
        incoming,
        layovers,
        departed,
        interventions,
      });
    }
    return states;
  }

  // Build the read-only terminal map debug view from a cached snapshot plus the raw realtime feed.
  // Vehicle coordinates exist only on rt.vehiclePositions (snapshot DTOs never carry lat/lon), so
  // each bus is joined back to the feed by vehicleId; buses without a fresh coordinate are skipped.
  buildMapSnapshot(terminalId: string, snapshot: TerminalSnapshot, rt: RealtimeSnapshot): TerminalMapSnapshot {
    const config = this.getConfig();
    const terminal = config.terminals.find((t) => t.id === terminalId);
    if (!terminal) throw new Error(`unknown terminal ${terminalId}`);
    const coords = this.stopCoords();
    const names = this.stopNames();

    // Buffer radii mirror the geofence arms in recordFacts: the arrival circle is the terminal
    // arrival geofence (per-terminal override wins), the movement/hysteresis circle extends it by
    // the terminal movement allowance, and the departure circle is the outbound departure trigger.
    const arrivalRadius = terminal.radiusMeters ?? config.arrivalRadiusMeters ?? 150;
    const movementMeters = config.terminalMovementMeters ?? 75;
    const departureRadius = config.departureTriggerMeters ?? 75;
    const buffers: TerminalMapBuffer[] = [];
    const stops: TerminalMapStop[] = [];
    let latSum = 0;
    let lonSum = 0;
    let centerCount = 0;
    for (const stopId of terminal.stopIds) {
      const coord = coords.get(stopId);
      if (!coord) continue;
      const name = names.get(stopId) ?? stopId;
      stops.push({ stopId, name, lat: coord.lat, lon: coord.lon });
      buffers.push(
        { stopId, lat: coord.lat, lon: coord.lon, radiusMeters: arrivalRadius, kind: 'arrival' },
        { stopId, lat: coord.lat, lon: coord.lon, radiusMeters: arrivalRadius + movementMeters, kind: 'movement' },
        { stopId, lat: coord.lat, lon: coord.lon, radiusMeters: departureRadius, kind: 'departure' },
      );
      latSum += coord.lat;
      lonSum += coord.lon;
      centerCount++;
    }
    // A terminal with no resolvable coordinates still gets a map, just without an anchor circle.
    const center = centerCount > 0
      ? { lat: latSum / centerCount, lon: lonSum / centerCount }
      : { lat: 0, lon: 0 };

    const vpByVehicle = new Map(rt.vehiclePositions.map((vp) => [vp.vehicleId, vp]));
    const vehicles: VehicleMapMarker[] = [];
    for (const route of snapshot.routes) {
      for (const bus of route.incoming) {
        const marker = this.toMapMarker(bus.vehicleId, bus.tripId, route, 'inbound', bus.etaSeconds, vpByVehicle, center);
        if (marker) vehicles.push(marker);
      }
      for (const bus of route.layovers) {
        // Layover pending flags classify the arrow: arrivalPending is the arrival arm before
        // dwell confirmation, departurePending is the departure arm after the trigger is crossed.
        const status: VehicleMapStatus = bus.arrivalPending === true
          ? 'arriving'
          : bus.departurePending === true
            ? 'departing'
            : 'laying_over';
        const marker = this.toMapMarker(bus.vehicleId, bus.tripId, route, status, undefined, vpByVehicle, center);
        if (marker) vehicles.push(marker);
      }
      for (const bus of route.departed) {
        const marker = this.toMapMarker(bus.vehicleId, bus.tripId, route, 'departed', undefined, vpByVehicle, center);
        if (marker) vehicles.push(marker);
      }
    }

    return {
      terminalId,
      terminalName: terminal.name,
      generatedAt: snapshot.generatedAt,
      center,
      buffers,
      stops,
      vehicles,
    };
  }

  // Normalize one bus into an arrow marker, joining its identity to the raw VP feed. The heading
  // prefers the vehicle's own compass bearing from the feed; when absent it falls back to the
  // implied direction of travel (toward the terminal while approaching/dwelling, away once it
  // departs), which keeps arrows pointing sensibly for feeds without a bearing field.
  private toMapMarker(
    vehicleId: string | undefined,
    tripId: string,
    route: RouteState,
    status: VehicleMapStatus,
    etaSeconds: number | undefined,
    vpByVehicle: ReadonlyMap<string, VehiclePositionInfo>,
    center: GeoPoint,
  ): VehicleMapMarker | undefined {
    if (!vehicleId) return undefined;
    const vp = vpByVehicle.get(vehicleId);
    if (vp === undefined || vp.lat === undefined || vp.lon === undefined) return undefined;
    const point = { lat: vp.lat, lon: vp.lon };
    const towardTerminal = bearingDegrees(point, center);
    const computed =
      (towardTerminal + (status === 'departing' || status === 'departed' ? 180 : 0)) % 360;
    const headingDegrees = vp.bearing !== undefined ? vp.bearing : computed;
    return {
      vehicleId,
      tripId,
      routeShortName: route.routeShortName,
      routeColor: route.color,
      status,
      lat: vp.lat,
      lon: vp.lon,
      headingDegrees,
      label: vehicleId,
      etaSeconds,
    };
  }

}
