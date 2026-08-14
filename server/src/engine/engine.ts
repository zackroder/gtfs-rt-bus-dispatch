import type { Database } from 'better-sqlite3';
import type {
  AppConfig,
  DepartedBus,
  HoldOverride,
  IncomingBus,
  Intervention,
  LayoverBus,
  RouteState,
  Terminal,
  TerminalSnapshot,
} from '../../../shared/types';
import type { RealtimeSnapshot } from '../providers/types';
import { activeServiceDate, activeServiceIds, getServiceDayStart, nowServiceSeconds, unixToServiceSeconds } from '../gtfs/time';
import {
  arrivalFact,
  buildBlockChains,
  buildDepartures,
  buildTripEnds,
  departureFact,
  type BlockChains,
  type FactSource,
  type RunRecord,
  type TripEnd,
} from './headway';
import { decideTriplets, type TripletDecision } from './dispatch';
import { outboundRoutesAtTerminal, routeShortName } from './terminal';

const RECENT_DEPARTURE_SECONDS = 30 * 60;

function destinationOf(headsign: string | undefined, routeShortName: string): string {
  if (!headsign) return routeShortName;
  const prefix = `${routeShortName} `;
  return headsign.startsWith(prefix) ? headsign.slice(prefix.length) : headsign;
}

interface RefreshContext {
  rt: RealtimeSnapshot;
  nowSvc: number;
  activeServiceIds: Set<string>;
  lookaheadSeconds: number;
  minRestSeconds: number;
  serviceDayStartSeconds: number;
  generatedAt: number;
}

export class Engine {
  private ledger = new Map<string, RunRecord>();
  private vehicleLastTrip = new Map<string, string>();
  private blockChainsCache?: BlockChains;
  private tripEndsCache?: Map<string, TripEnd>;

  constructor(
    private db: Database,
    private getConfig: () => AppConfig,
  ) {}

  invalidateStaticCaches(): void {
    this.blockChainsCache = undefined;
    this.tripEndsCache = undefined;
  }

  private blockChains(): BlockChains {
    if (!this.blockChainsCache) this.blockChainsCache = buildBlockChains(this.db);
    return this.blockChainsCache;
  }

  private tripEnds(): Map<string, TripEnd> {
    if (!this.tripEndsCache) this.tripEndsCache = buildTripEnds(this.db);
    return this.tripEndsCache;
  }

  refresh(rt: RealtimeSnapshot, now: Date = new Date(), terminalIds?: Set<string>): TerminalSnapshot[] {
    const config = this.getConfig();
    const serviceDayStartSeconds = getServiceDayStart(this.db);
    const nowSvc = nowServiceSeconds(now, serviceDayStartSeconds);
    this.recordFacts(rt, nowSvc, serviceDayStartSeconds);

    const activeDate = activeServiceDate(now, serviceDayStartSeconds);
    const ctx: RefreshContext = {
      rt,
      nowSvc,
      activeServiceIds: activeServiceIds(this.db, activeDate),
      lookaheadSeconds: config.lookaheadMinutes * 60,
      minRestSeconds: config.minRestMinutes * 60,
      serviceDayStartSeconds,
      generatedAt: Math.floor(now.getTime() / 1000),
    };

    const wanted = terminalIds ?? new Set(config.terminals.map((t) => t.id));
    const blockChains = this.blockChains();
    const snapshots: TerminalSnapshot[] = [];
    for (const terminal of config.terminals) {
      if (!wanted.has(terminal.id)) continue;
      const routes = this.buildRouteStates(terminal, ctx, blockChains);
      if (routes.length === 0) continue;
      snapshots.push({
        terminalId: terminal.id,
        generatedAt: ctx.generatedAt,
        serviceDayStartSeconds: ctx.serviceDayStartSeconds,
        routes,
      });
    }
    return snapshots;
  }

  private recordArrival(tripId: string, at: number, source: FactSource): void {
    const record = this.ledger.get(tripId) ?? {};
    if (record.arrivalSource === 'vp') return;
    if (record.arrivalSeconds !== undefined && source === 'tu') return;
    if (record.arrivalSeconds === at && record.arrivalSource === source) return;
    record.arrivalSeconds = at;
    record.arrivalSource = source;
    this.ledger.set(tripId, record);
  }

  private recordDeparture(tripId: string, at: number, source: FactSource): void {
    const record = this.ledger.get(tripId) ?? {};
    if (record.departureSource === 'vp') return;
    if (record.departureSeconds !== undefined && source === 'tu') return;
    if (record.departureSeconds === at && record.departureSource === source) return;
    record.departureSeconds = at;
    record.departureSource = source;
    this.ledger.set(tripId, record);
  }

  private recordFacts(rt: RealtimeSnapshot, nowSvc: number, serviceDayStartSeconds: number): void {
    const chains = this.blockChains();
    const ends = this.tripEnds();

    for (const vp of rt.vehiclePositions) {
      if (!vp.tripId) continue;
      const end = ends.get(vp.tripId);
      if (!end) continue;
      const vpSeconds = Math.min(
        unixToServiceSeconds(vp.timestamp, serviceDayStartSeconds),
        nowSvc,
      );

      const atLastStop =
        vp.stopId === end.lastStopId || vp.currentStopSequence === end.lastStopSequence;
      if (atLastStop) {
        const nextTripId = chains.nextTrip.get(vp.tripId);
        if (nextTripId) this.recordArrival(nextTripId, vpSeconds, 'vp');
      }

      const pastFirstStop =
        !atLastStop &&
        ((vp.currentStopSequence !== undefined && vp.currentStopSequence > end.firstStopSequence) ||
          (vp.stopId !== undefined && vp.stopId !== end.firstStopId));
      if (pastFirstStop) this.recordDeparture(vp.tripId, vpSeconds, 'vp');

      const lastTrip = this.vehicleLastTrip.get(vp.vehicleId);
      if (lastTrip && lastTrip !== vp.tripId) {
        this.recordDeparture(lastTrip, vpSeconds, 'vp');
      }
      this.vehicleLastTrip.set(vp.vehicleId, vp.tripId);
    }

    for (const tu of rt.tripUpdates) {
      const end = ends.get(tu.tripId);
      if (!end) continue;

      const dep = departureFact(tu, end.firstStopId, end.firstDeparture, serviceDayStartSeconds, nowSvc);
      if (dep.departed && dep.departureSeconds !== undefined) {
        this.recordDeparture(tu.tripId, dep.departureSeconds, 'tu');
      }

      const nextTripId = chains.nextTrip.get(tu.tripId);
      if (nextTripId) {
        const arr = arrivalFact(tu, end.lastStopId, end.lastArrival, serviceDayStartSeconds);
        if (arr.predicted <= nowSvc) {
          this.recordArrival(nextTripId, arr.predicted, 'tu');
        }
      }
    }
  }

  private buildRouteStates(
    terminal: Terminal,
    ctx: RefreshContext,
    blockChains: BlockChains,
  ): RouteState[] {
    const config = this.getConfig();
    const routeIds =
      terminal.routeIds ??
      outboundRoutesAtTerminal(
        this.db,
        terminal.stopIds,
        ctx.activeServiceIds,
        ctx.nowSvc,
        ctx.nowSvc + ctx.lookaheadSeconds,
      );
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
      });
      if (departures.length === 0) continue;

      const decisions = decideTriplets(departures, {
        nowSvc: ctx.nowSvc,
        leadTimeSeconds: config.leadTimeMinutes * 60,
        maxHoldSeconds: config.maxHoldMinutes * 60,
      });
      const interventions: Intervention[] = [];
      for (const decision of decisions) {
        this.lockHold(decision.tripId, decision);
        const departure = departures.find((d) => d.tripId === decision.tripId);
        if (departure) {
          departure.hold = { holdSeconds: decision.holdSeconds, effectiveDeparture: decision.until, reason: decision.reason };
        }
        interventions.push({
          id: `hold:${terminal.id}:${routeId}:${decision.tripId}`,
          terminalId: terminal.id,
          routeId,
          rule: 'hold',
          vehicleId: decision.vehicleId,
          leaderVehicleId: decision.leaderVehicleId,
          followerVehicleId: decision.followerVehicleId,
          holdSeconds: decision.holdSeconds,
          until: decision.until,
          reason: decision.reason,
          generatedAt: ctx.generatedAt,
        });
      }

      const shortName = routeShortName(this.db, routeId);
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
            nextDestination: destinationOf(departure.headsign, shortName),
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
            terminalArrival: departure.terminalArrival ?? 0,
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
            headsign: destinationOf(departure.headsign, shortName),
            scheduledDeparture: departure.scheduledDeparture,
            departureSeconds: departure.departedSeconds,
          });
        }
      }
      incoming.sort((a, b) => a.etaSeconds - b.etaSeconds);
      layovers.sort((a, b) => a.predictedDeparture - b.predictedDeparture);
      departed.sort((a, b) => b.departureSeconds - a.departureSeconds);

      states.push({
        routeId,
        routeShortName: shortName,
        incoming,
        layovers,
        departed,
        interventions,
      });
    }
    return states;
  }

  private lockHold(tripId: string, decision: TripletDecision): void {
    const record = this.ledger.get(tripId) ?? {};
    record.hold = {
      holdSeconds: decision.holdSeconds,
      effectiveDeparture: decision.until,
      reason: decision.reason,
    } satisfies HoldOverride;
    this.ledger.set(tripId, record);
  }
}
