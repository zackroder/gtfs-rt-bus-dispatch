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
  type RunRecord,
  type TripEnd,
} from './headway';
import { decideTriplets } from './dispatch';
import { outboundRoutesAtTerminal, routeStyle } from './terminal';

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

export class Engine {
  private ledger = new Map<string, RunRecord>();
  private vehicleLastTrip = new Map<string, string>();
  private blockChainsCache?: BlockChains;
  private blockChainsCacheKey?: string;
  private tripEndsCache?: Map<string, TripEnd>;
  private stopNamesCache?: Map<string, string>;
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
    this.vehicleStopCache.clear();
    this.ledger.clear();
    this.vehicleLastTrip.clear();
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
      this.vehicleLastTrip.clear();
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
    this.recordFacts(
      rt,
      nowSvc,
      serviceDayStartSeconds,
      generatedAt,
      activeDate,
      this.blockChains(activeIds),
      terminalStopIds,
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

  private recordFacts(
    rt: RealtimeSnapshot,
    nowSvc: number,
    serviceDayStartSeconds: number,
    generatedAt: number,
    serviceDate: string,
    chains: BlockChains,
    terminalStopIds: Set<string>,
  ): void {
    const ends = this.tripEnds();
    this.vpDiagnostics = [];

    for (const vp of rt.vehiclePositions) {
      const vpSeconds = vp.timestamp > generatedAt
        ? nowSvc
        : unixToServiceSeconds(vp.timestamp, serviceDayStartSeconds);
      // Future-dated provider timestamps cannot describe an event after the current refresh.
      const lastTrip = this.vehicleLastTrip.get(vp.vehicleId);
      const tripChanged = lastTrip !== undefined && lastTrip !== vp.tripId;
      const diagnostic: VehiclePositionDiagnostic = {
        vehicleId: vp.vehicleId,
        tripId: vp.tripId,
        previousTripId: lastTrip,
        stopId: vp.stopId,
        currentStopSequence: vp.currentStopSequence,
        observationTimestamp: vp.timestamp,
        ageSeconds: Math.max(0, generatedAt - vp.timestamp),
        matchedTrip: false,
        atLastStop: false,
        pastFirstStop: false,
        tripChanged,
        recordedArrival: false,
        recordedDeparture: false,
        reasons: [],
      };
      if (!vp.tripId) {
        diagnostic.reasons.push('missing_trip_id');
        const previousEnd = lastTrip ? ends.get(lastTrip) : undefined;
        if (previousEnd && lastTrip !== undefined) {
          diagnostic.matchedTrip = true;
          diagnostic.firstStopId = previousEnd.firstStopId;
          diagnostic.firstStopSequence = previousEnd.firstStopSequence;
          diagnostic.lastStopId = previousEnd.lastStopId;
          diagnostic.lastStopSequence = previousEnd.lastStopSequence;
          diagnostic.pastFirstStop =
            (vp.currentStopSequence !== undefined && vp.currentStopSequence > previousEnd.firstStopSequence) ||
            (vp.stopId !== undefined && vp.stopId !== previousEnd.firstStopId);
          if (diagnostic.pastFirstStop && terminalStopIds.has(previousEnd.firstStopId)) {
            diagnostic.departureCandidateTripId = lastTrip;
            diagnostic.recordedDeparture = this.recordDeparture(
              lastTrip,
              vpSeconds,
              'vp',
              generatedAt,
              serviceDate,
              vp.vehicleId,
            );
          } else if (diagnostic.pastFirstStop) {
            diagnostic.reasons.push('past_first_stop_not_outbound');
          }
        }
        if (!diagnostic.recordedDeparture) diagnostic.reasons.push('no_departure_transition');
        this.vpDiagnostics.push(diagnostic);
        continue;
      }
      if (tripChanged && lastTrip) {
        // A vehicle changing trips is evidence that its previous trip departed, even if the
        // feed skipped the intermediate stop sequence.
        diagnostic.departureCandidateTripId = lastTrip;
        const previousEnd = ends.get(lastTrip);
        if (previousEnd && terminalStopIds.has(previousEnd.firstStopId)) {
          diagnostic.recordedDeparture = this.recordDeparture(
            lastTrip,
            vpSeconds,
            'vp',
            generatedAt,
            serviceDate,
            vp.vehicleId,
          );
        } else {
          diagnostic.reasons.push('previous_trip_not_outbound_at_terminal');
        }
        diagnostic.reasons.push('trip_changed');
      }
      const end = ends.get(vp.tripId);
      if (!end) {
        diagnostic.reasons.push('trip_not_in_static_feed');
        this.vpDiagnostics.push(diagnostic);
        this.vehicleLastTrip.set(vp.vehicleId, vp.tripId);
        continue;
      }
      diagnostic.matchedTrip = true;
      diagnostic.firstStopId = end.firstStopId;
      diagnostic.firstStopSequence = end.firstStopSequence;
      diagnostic.lastStopId = end.lastStopId;
      diagnostic.lastStopSequence = end.lastStopSequence;
      const atLastStop =
        vp.stopId === end.lastStopId || vp.currentStopSequence === end.lastStopSequence;
      diagnostic.atLastStop = atLastStop;
      if (atLastStop) {
        diagnostic.reasons.push('at_last_stop');
        const nextTripId = chains.nextTrip.get(vp.tripId);
        if (nextTripId) {
          diagnostic.arrivalCandidateTripId = nextTripId;
          diagnostic.recordedArrival = this.recordArrival(
            nextTripId,
            vpSeconds,
            'vp',
            generatedAt,
            serviceDate,
            vp.vehicleId,
          );
        } else {
          diagnostic.reasons.push('no_next_block_trip');
        }
      }

      const pastFirstStop =
        ((vp.currentStopSequence !== undefined && vp.currentStopSequence > end.firstStopSequence) ||
          (vp.stopId !== undefined && vp.stopId !== end.firstStopId));
      diagnostic.pastFirstStop = pastFirstStop;
      if (pastFirstStop && terminalStopIds.has(end.firstStopId)) {
        // Once VP has moved beyond the first outbound stop, the trip has actually departed.
        diagnostic.departureCandidateTripId = vp.tripId;
        diagnostic.recordedDeparture = this.recordDeparture(
          vp.tripId,
          vpSeconds,
          'vp',
          generatedAt,
          serviceDate,
          vp.vehicleId,
        ) || diagnostic.recordedDeparture;
        diagnostic.reasons.push('past_first_stop');
      } else if (pastFirstStop) {
        diagnostic.reasons.push('past_first_stop_not_outbound');
      }

      if (!diagnostic.recordedArrival && !diagnostic.recordedDeparture && diagnostic.reasons.length === 0) {
        diagnostic.reasons.push('no_transition');
      }
      this.vpDiagnostics.push(diagnostic);
      this.vehicleLastTrip.set(vp.vehicleId, vp.tripId);
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
