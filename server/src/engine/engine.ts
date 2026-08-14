import type { Database } from 'better-sqlite3';
import type {
  AppConfig,
  HoldOverride,
  IncomingBus,
  Intervention,
  LayoverBus,
  RouteState,
  Terminal,
  TerminalSnapshot,
} from '../../../shared/types';
import type { RealtimeSnapshot } from '../providers/types';
import { activeServiceDate, activeServiceIds, getServiceDayStart, nowServiceSeconds } from '../gtfs/time';
import { buildDepartures, type OutboundDeparture, type RunRecord } from './headway';
import { decideTriplets, type TripletDecision } from './dispatch';
import { outboundRoutesAtTerminal, routeShortName } from './terminal';

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

  constructor(
    private db: Database,
    private getConfig: () => AppConfig,
  ) {}

  refresh(rt: RealtimeSnapshot, now: Date = new Date()): TerminalSnapshot[] {
    const config = this.getConfig();
    const serviceDayStartSeconds = getServiceDayStart(this.db);
    const nowSvc = nowServiceSeconds(now, serviceDayStartSeconds);
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

    const snapshots: TerminalSnapshot[] = [];
    for (const terminal of config.terminals) {
      const routes = this.buildRouteStates(terminal, ctx);
      if (routes.length === 0) continue;
      snapshots.push({ terminalId: terminal.id, generatedAt: ctx.generatedAt, routes });
    }
    return snapshots;
  }

  private buildRouteStates(terminal: Terminal, ctx: RefreshContext): RouteState[] {
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
      });
      if (departures.length === 0) continue;

      this.recordFacts(ctx, departures);

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
        }
      }
      incoming.sort((a, b) => a.etaSeconds - b.etaSeconds);
      layovers.sort((a, b) => a.predictedDeparture - b.predictedDeparture);

      states.push({ routeId, routeShortName: shortName, incoming, layovers, interventions });
    }
    return states;
  }

  private recordFacts(ctx: RefreshContext, departures: OutboundDeparture[]): void {
    for (const departure of departures) {
      let record = this.ledger.get(departure.tripId);
      if (!record) {
        record = {};
        this.ledger.set(departure.tripId, record);
      }
      if (record.arrivalSeconds === undefined && departure.predictedArrival <= ctx.nowSvc) {
        record.arrivalSeconds = departure.predictedArrival;
      }
      if (record.departureSeconds === undefined && departure.departureObs.departed) {
        record.departureSeconds = departure.departureObs.departureSeconds ?? ctx.nowSvc;
      }
    }
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
