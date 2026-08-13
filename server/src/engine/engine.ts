import type { Database } from 'better-sqlite3';
import type {
  AppConfig,
  IncomingBus,
  LayoverBus,
  RouteState,
  Terminal,
  TerminalSnapshot,
} from '../../../shared/types';
import type { RealtimeSnapshot } from '../providers/types';
import { activeServiceDate, activeServiceIds, getServiceDayStart, nowServiceSeconds } from '../gtfs/time';
import { buildDepartures } from './headway';
import { computeInterventions } from './interventions';
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
      });
      if (departures.length === 0) continue;

      const result = computeInterventions(departures, {
        terminalId: terminal.id,
        routeId,
        nowSvc: ctx.nowSvc,
        generatedAt: ctx.generatedAt,
        rules: config,
      });

      const shortName = routeShortName(this.db, routeId);
      const incoming: IncomingBus[] = [];
      const layovers: LayoverBus[] = [];
      for (const departure of result.departures) {
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
        } else {
          layovers.push({
            routeId,
            routeShortName: shortName,
            tripId: departure.tripId,
            vehicleId: departure.vehicleId,
            scheduledDeparture: departure.scheduledDeparture,
            predictedDeparture:
              departure.predictedDeparture + (departure.hold?.holdSeconds ?? 0),
            countdownSeconds: departure.scheduledDeparture - ctx.nowSvc,
            hold: departure.hold,
            minRestAdvisory: departure.minRest || undefined,
          });
        }
      }
      incoming.sort((a, b) => a.etaSeconds - b.etaSeconds);
      layovers.sort((a, b) => a.scheduledDeparture - b.scheduledDeparture);

      states.push({ routeId, routeShortName: shortName, incoming, layovers, interventions: result.interventions });
    }
    return states;
  }
}
