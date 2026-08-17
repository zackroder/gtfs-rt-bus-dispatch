import type { Database } from 'better-sqlite3';
import type {
  AppConfig,
  DepartedBus,
  IncomingBus,
  LayoverBus,
  RouteState,
  Terminal,
  TerminalSnapshot,
  VehiclePositionInfo,
} from '../../../shared/types';
import type { RealtimeSnapshot } from '../providers/types';
import { InterventionStore } from '../db/interventions';
import { activeServiceDate, activeServiceIds, getServiceDayStart, nowServiceSeconds, unixToServiceSeconds } from '../gtfs/time';
import {
  buildBlockChains,
  buildDepartures,
  buildTripEnds,
  type BlockChains,
  type ArrivalAtStop,
  type FactSource,
  type OutboundDeparture,
  type RunRecord,
  type TripEnd,
  type VehicleTerminalState,
} from './headway';
import { decideTriplets } from './dispatch';
import { outboundRoutesAtTerminal, routeStyle } from './terminal';
import { distanceMeters, distanceToStopMeters, stopCoordinates, type GeoPoint } from './geometry';

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
}

// Per-vehicle transition state held across refreshes. Only one arm and one layover
// exist per vehicle at a time; committed facts live in the trip-keyed ledger.
interface VehicleTrack {
  tripId?: string;
  lat?: number;
  lon?: number;
  observedAtSvc?: number;
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
      const row = this.db
        .prepare('SELECT stop_id FROM stop_times WHERE trip_id = ? AND stop_sequence = ?')
        .get(vp.tripId, vp.currentStopSequence) as { stop_id?: string } | undefined;
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
    const serviceDayStartSeconds = getServiceDayStart(this.db);
    const nowSvc = nowServiceSeconds(now, serviceDayStartSeconds);
    const activeDate = activeServiceDate(now, serviceDayStartSeconds);
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
    const terminalStopIds = new Set(config.terminals.flatMap((terminal) => terminal.stopIds));
    const vpTerminalState = new Map<string, VehicleTerminalState>();
    this.recordFacts(
      rt,
      nowSvc,
      serviceDayStartSeconds,
      generatedAt,
      activeDate,
      this.blockChains(activeIds),
      terminalStopIds,
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
    generatedAt: number,
    serviceDate: string,
    vehicleId?: string,
  ): boolean {
    const record = this.ledger.get(tripId) ?? {};
    if (record.arrivalSource === 'vp') return false;
    if (record.arrivalSeconds !== undefined && source === 'tu') return false;
    if (record.arrivalSeconds === at && record.arrivalSource === source) return false;
    record.arrivalSeconds = at;
    record.arrivalSource = source;
    this.ledger.set(tripId, record);
    this.persistRunFact(serviceDate, tripId, record, generatedAt);
    this.recordFactEvent({ action: 'arrival', tripId, vehicleId, at, generatedAt, source });
    return true;
  }

  private recordDeparture(
    tripId: string,
    at: number,
    source: FactSource,
    generatedAt: number,
    serviceDate: string,
    vehicleId?: string,
  ): boolean {
    const record = this.ledger.get(tripId) ?? {};
    if (record.departureSource === 'vp') return false;
    // Apply the same VP-over-TU precedence to departures and resolve any hold when the run leaves.
    if (record.departureSeconds !== undefined && source === 'tu') return false;
    if (record.departureSeconds === at && record.departureSource === source) return false;
    record.departureSeconds = at;
    record.departureSource = source;
    this.ledger.set(tripId, record);
    this.persistRunFact(serviceDate, tripId, record, generatedAt);
    this.interventions.completeTrip(serviceDate, tripId, generatedAt);
    this.recordFactEvent({ action: 'departure', tripId, vehicleId, at, generatedAt, source });
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
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO run_events
         (service_date, event_type, trip_id, vehicle_id, terminal_id, route_id, source,
          value_seconds, generated_at, classification, edt_seconds,
          scheduled_departure, scheduled_arrival, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const createdAt = Math.floor(Date.now() / 1000);
    if (departure.terminalArrival !== undefined && record?.arrivalSource !== undefined) {
      insert.run(
        ctx.serviceDate, 'arrival', departure.tripId, departure.vehicleId ?? null,
        terminalId, routeId, record.arrivalSource, departure.terminalArrival,
        ctx.generatedAt, departure.state, departure.edt,
        departure.scheduledDeparture, departure.scheduledArrival, createdAt,
      );
    }
    if (departure.departedSeconds !== undefined && record?.departureSource !== undefined) {
      insert.run(
        ctx.serviceDate, 'departure', departure.tripId, departure.vehicleId ?? null,
        terminalId, routeId, record.departureSource, departure.departedSeconds,
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
        departureSeconds: row.departure_seconds ?? undefined,
        departureSource: row.departure_seconds !== null ? 'vp' : undefined,
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
  ): string | undefined {
    const ends = this.tripEnds();
    const current = ends.get(tripId);
    if (!current) return undefined;
    const terminalStopIds = new Set(this.getConfig().terminals.flatMap((t) => t.stopIds));
    if (terminalStopIds.has(current.firstStopId)) return tripId;

    const next = chains.nextTrip.get(tripId);
    const nextEnd = next ? ends.get(next) : undefined;
    if (nextEnd && terminalStopIds.has(nextEnd.firstStopId)) return next;

    const tuTrip = rt.tripUpdates.find((u) => u.vehicleId === vehicleId)?.tripId;
    const tuEnd = tuTrip ? ends.get(tuTrip) : undefined;
    if (tuEnd && terminalStopIds.has(tuEnd.firstStopId)) return tuTrip;
    return undefined;
  }

  private recordFacts(
    rt: RealtimeSnapshot,
    nowSvc: number,
    serviceDayStartSeconds: number,
    generatedAt: number,
    serviceDate: string,
    chains: BlockChains,
    terminalStopIds: Set<string>,
    vpTerminalState: Map<string, VehicleTerminalState>,
  ): void {
    const config = this.getConfig();
    const ends = this.tripEnds();
    this.vpDiagnostics = [];
    const stationaryMeters = config.stationaryDisplacementMeters ?? 20;
    const confirmPings = config.confirmPings ?? 2;
    const departPings = config.departPings ?? 2;
    // Movement allowance: once a bus has a layover posture, it stays layover while it remains
    // inside the hold zone (arrival radius + movement allowance). This lets a bus pull forward
    // within the terminal without being dropped from layover or mis-recorded as departed.
    const movementMeters = config.terminalMovementMeters ?? 75;

    for (const vp of rt.vehiclePositions) {
      const vpSeconds = vp.timestamp > generatedAt
        ? nowSvc
        : unixToServiceSeconds(vp.timestamp, serviceDayStartSeconds);
      // Future-dated provider timestamps cannot describe an event after the current refresh.
      const track = this.vehicleTracks.get(vp.vehicleId) ?? {
        parkedStreak: 0,
        departStreak: 0,
      };
      const point = vp.lat !== undefined && vp.lon !== undefined ? { lat: vp.lat, lon: vp.lon } : undefined;
      const displacementM =
        point && track.lat !== undefined && track.lon !== undefined
          ? distanceMeters(point, { lat: track.lat, lon: track.lon })
          : undefined;
      const tripChanged = track.tripId !== undefined && vp.tripId !== undefined && track.tripId !== vp.tripId;

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
      if (!vp.tripId || !ends.has(vp.tripId)) {
        diagnostic.reasons.push(!vp.tripId ? 'missing_trip_id' : 'trip_not_in_static_feed');
        this.vpDiagnostics.push(diagnostic);
        track.tripId = vp.tripId ?? track.tripId;
        track.lat = point?.lat;
        track.lon = point?.lon;
        track.observedAtSvc = vpSeconds;
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
      // confirms that trip's arrival (certain-but-late), and flipping away from an outbound
      // trip confirms its departure. The inbound leg P is never "departed" by a P->D flip —
      // P left its far-end terminal hours earlier and that was recorded by its own motion.
      if (tripChanged && track.tripId) {
        const prevEnd = ends.get(track.tripId);
        if (end.firstStopId && terminalStopIds.has(end.firstStopId)) {
          diagnostic.arrivalCandidateTripId = vp.tripId;
          diagnostic.recordedArrival = this.recordArrival(
            vp.tripId,
            vpSeconds,
            'vp',
            generatedAt,
            serviceDate,
            vp.vehicleId,
          );
          diagnostic.reasons.push('flip_in_arrival');
        }
        if (prevEnd && prevEnd.firstStopId && terminalStopIds.has(prevEnd.firstStopId)) {
          diagnostic.departureCandidateTripId = track.tripId;
          diagnostic.recordedDeparture = this.recordDeparture(
            track.tripId,
            vpSeconds,
            'vp',
            generatedAt,
            serviceDate,
            vp.vehicleId,
          );
          diagnostic.reasons.push('flip_away_departure');
        }
        if (diagnostic.reasons.length === 0 && prevEnd) {
          diagnostic.reasons.push('trip_changed_no_terminal');
        }
      }

      // The terminal anchor is the last stop of the current (inbound) trip. A stop_id match is a
      // cheap authoritative hint (CTA sends it ~8% of the time); proximity covers the rest. The
      // hold zone widens the arm radius by the movement allowance so a bus that pulls forward
      // within the terminal is neither dropped from layover nor mis-recorded as departed.
      const anchorStopId = end.lastStopId;
      const inTerminal = anchorStopId !== undefined && terminalStopIds.has(anchorStopId);
      const distToTerminal = inTerminal && point
        ? distanceToStopMeters(this.stopCoords(), anchorStopId, point)
        : Infinity;
      const radius = this.terminalRadiusMeters(anchorStopId);
      const holdRadius = radius + movementMeters;
      const atAnchorStop = inTerminal && vp.stopId === anchorStopId;
      diagnostic.distToTerminalM = Number.isFinite(distToTerminal) ? Math.round(distToTerminal) : undefined;
      diagnostic.inTerminalBuffer = inTerminal && (atAnchorStop || distToTerminal <= radius);
      diagnostic.parked =
        diagnostic.inTerminalBuffer && (displacementM === undefined || displacementM < stationaryMeters);

      // Arrival arm: commit once confirmPings parked pings elapse, keyed to the outbound trip the
      // vehicle forms. The flip onto that trip remains the certain-but-late fallback. The arm is
      // gated on stationarity so a through-bus merely crossing the buffer cannot phantom-arm, but
      // once armed it survives movement within the hold zone (terminal inching).
      if (diagnostic.inTerminalBuffer && diagnostic.parked) {
        const target = this.arrivalTargetFor(vp.tripId, vp.vehicleId, rt, chains);
        if (target) {
          const alreadyArrived = this.ledger.get(target)?.arrivalSeconds !== undefined;
          if (!alreadyArrived) {
            if (track.parkedStreak === 0) {
              track.armAtSvc = vpSeconds;
              track.armTripId = target;
            }
            track.parkedStreak++;
            if (track.parkedStreak >= confirmPings) {
              diagnostic.arrivalCandidateTripId = target;
              diagnostic.recordedArrival = this.recordArrival(
                target,
                track.armAtSvc ?? vpSeconds,
                'vp',
                generatedAt,
                serviceDate,
                vp.vehicleId,
              );
              track.layoverTripId = target;
              track.layoverAnchorStopId = this.tripEnds().get(target)?.firstStopId;
              track.parkedStreak = 0;
              track.armTripId = undefined;
            } else {
              diagnostic.reasons.push('arrival_armed');
            }
          } else {
            diagnostic.reasons.push('arrival_already_recorded');
          }
        } else {
          diagnostic.reasons.push('no_arrival_target');
        }
      } else if (inTerminal && (atAnchorStop || distToTerminal <= holdRadius)) {
        // Inside the hold zone: movement is tolerated. Keep an existing arm alive so a bus that
        // arrives then inches forward still commits; a never-armed bus just passing through resets.
        if (track.armTripId) {
          diagnostic.reasons.push('arrival_armed_holding');
        } else {
          diagnostic.reasons.push('in_hold_zone_unarmed');
          track.parkedStreak = 0;
        }
      } else if (diagnostic.parked) {
        diagnostic.reasons.push('parked_not_in_terminal_buffer');
      }

      // Position-based departure: a vehicle already operating an outbound trip and beyond the
      // hold zone has left. This recovers departures for buses first seen mid-route when the
      // pull-out motion was never observed, mirroring the old past-first-stop rule.
      if (end.firstStopId && terminalStopIds.has(end.firstStopId) && point) {
        const outDist = distanceToStopMeters(this.stopCoords(), end.firstStopId, point);
        if (outDist > holdRadius) {
          diagnostic.departureCandidateTripId = vp.tripId;
          diagnostic.recordedDeparture = this.recordDeparture(
            vp.tripId,
            vpSeconds,
            'vp',
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

      // Layover departure by motion: a committed layover that leaves the hold zone and shows
      // motion for departPings consecutive pings has pulled out. The anchor is stop 1 of the
      // outbound trip (the departure bay), per the corrected geometry; the hold zone tolerance
      // keeps a bus that inches within the terminal in layover.
      if (track.layoverTripId && track.layoverAnchorStopId && point) {
        const layoverDist = distanceToStopMeters(this.stopCoords(), track.layoverAnchorStopId, point);
        const layoverRadius = this.terminalRadiusMeters(track.layoverAnchorStopId) + movementMeters;
        const inLayoverBuffer = layoverDist <= layoverRadius;
        const moving = displacementM !== undefined && displacementM >= stationaryMeters;
        if (!inLayoverBuffer && moving) {
          if (track.departStreak === 0) track.departAtSvc = vpSeconds;
          track.departStreak++;
          if (track.departStreak >= departPings) {
            diagnostic.departureCandidateTripId = track.layoverTripId;
            diagnostic.recordedDeparture = this.recordDeparture(
              track.layoverTripId,
              track.departAtSvc ?? vpSeconds,
              'vp',
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

      vpTerminalState.set(vp.vehicleId, {
        inBuffer: diagnostic.inTerminalBuffer,
        parked: diagnostic.parked,
        distToTerminalM: diagnostic.distToTerminalM,
        armTripId: track.armTripId,
        layoverTripId: track.layoverTripId,
      });

      track.tripId = vp.tripId;
      track.lat = point?.lat;
      track.lon = point?.lon;
      track.observedAtSvc = vpSeconds;
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
      });

      const decisions = decideTriplets(departures, {
        nowSvc: ctx.nowSvc,
        leadTimeSeconds: config.leadTimeMinutes * 60,
        maxHoldSeconds: config.maxHoldMinutes * 60,
        requireObservedArrival: true,
      });
      // Suggestions are persisted before the route response; repeated refreshes therefore remain
      // idempotent and approval is the only path that applies a hold to the ledger.
      for (const decision of decisions) {
        this.interventions.createSuggestion({
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
          expiresAt: ctx.generatedAt + ((decision.until - ctx.nowSvc + 86400) % 86400),
        });
      }
      const interventions = this.interventions.listForRoute(ctx.serviceDate, terminal.id, routeId);

      const style = routeStyle(this.db, routeId);
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
            expectedDeparture: departure.edt,
            predictedDeparture,
            countdownSeconds: predictedDeparture - ctx.nowSvc,
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

}
