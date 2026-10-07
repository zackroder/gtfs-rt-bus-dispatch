import { Router, type Request, type Response } from 'express';
import type { Database } from 'better-sqlite3';
import {
  appConfigSchema,
  blockTimelineSchema,
  interventionActionSchema,
  terminalMapSnapshotSchema,
  vehicleDetailSchema,
  type AppConfig,
  type BlockTimeline,
  type InterventionStatus,
  type TerminalMapSnapshot,
  type TerminalSnapshot,
  type VehicleDetail,
} from '../../../shared/types';
import { recordConfigEvent, redactConfig } from '../config';
import { ACTIVITY_LOOKBACK_SECONDS, activeRoutesByStop, routeStyle } from '../engine/terminal';
import {
  InterventionConflictError,
  InterventionStore,
} from '../db/interventions';
import { activeServiceDate, activeServiceIds, getServiceDayStart, nowServiceSeconds } from '../gtfs/time';

// Route labels, rather than opaque route IDs, are the user-facing sort key.
function byRouteName(a: { shortName: string; routeId: string }, b: { shortName: string; routeId: string }): number {
  const nameA = a.shortName || a.routeId;
  const nameB = b.shortName || b.routeId;
  return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
}

export interface ApiDeps {
  db: Database;
  getConfig(): AppConfig;
  applyConfig(next: AppConfig): AppConfig;
  // Resolves on demand (compute-on-miss) so REST reads work without a WS subscriber; a known
  // terminal always resolves once a realtime snapshot exists, and rejects on engine failure.
  computeTerminal(terminalId: string): Promise<TerminalSnapshot | undefined>;
  computeTerminalMap(terminalId: string): Promise<TerminalMapSnapshot | undefined>;
  computeVehicleDetail(terminalId: string, tripId: string): Promise<VehicleDetail | undefined>;
  computeBlockTimeline(blockId: string): Promise<BlockTimeline | undefined>;
  getHealth(): {
    ok: boolean;
    lastRefreshAt: number | null;
    staticLoadedAt: number | null;
    ready?: boolean;
    phase?: 'starting' | 'loading_static' | 'ready' | 'refreshing' | 'error';
    staticLoading?: boolean;
    refreshInFlight?: boolean;
    startupError?: string | null;
    lastRefreshError?: string | null;
    lastStaticLoadDurationMs?: number | null;
    lastRefreshDurationMs?: number | null;
  };
  getVpDiagnostics(): unknown;
  reloadStatic(): Promise<void>;
  refreshOnce(): Promise<void>;
  interventions: InterventionStore;
}

// Keep response construction in one place so every endpoint uses Express JSON serialization.
function sendJson(res: Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

function routeIdsForTerminal(db: Database, stopIds: string[]): string[] {
  // Auto-discovered terminals need their route association derived from static stop_times.
  if (stopIds.length === 0) return [];
  const placeholders = stopIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT DISTINCT t.route_id
       FROM trips t JOIN stop_times st ON st.trip_id = t.trip_id
       WHERE st.stop_id IN (${placeholders})`,
    )
    .all(...stopIds) as Array<{ route_id: string }>;
  return rows.map((row) => row.route_id);
}

// Build the API router around injectable stores and engine callbacks for production and tests.
export function createApi(deps: ApiDeps): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    sendJson(res, 200, deps.getHealth());
  });

  router.get('/diagnostics/vp', (_req, res) => {
    // This endpoint is intentionally read-only: it exposes enough VP state to diagnose
    // missed transitions without allowing debug inspection to mutate the dispatch ledger.
    sendJson(res, 200, deps.getVpDiagnostics());
  });

  router.get('/run-events', (req, res) => {
    // Read-only audit of observed arrivals/departures for debugging and tuning. Filterable by
    // service date, terminal, and event type, with a bounded limit to keep responses small.
    const serviceDate = typeof req.query.serviceDate === 'string'
      ? req.query.serviceDate
      : activeServiceDate(new Date(), getServiceDayStart(deps.db), deps.getConfig().agencyTimezone);
    const terminalId = typeof req.query.terminalId === 'string' ? req.query.terminalId : undefined;
    const eventType = typeof req.query.type === 'string' ? req.query.type : undefined;
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 2000);
    const clauses: string[] = ['service_date = ?'];
    const params: Array<string | number> = [serviceDate];
    if (terminalId) { clauses.push('terminal_id = ?'); params.push(terminalId); }
    if (eventType === 'arrival' || eventType === 'departure') { clauses.push('event_type = ?'); params.push(eventType); }
    const rows = deps.db
      .prepare(
       `SELECT service_date, event_type, trip_id, vehicle_id, terminal_id, route_id, source, evidence,
                value_seconds, generated_at, classification, edt_seconds,
                scheduled_departure, scheduled_arrival
         FROM run_events
         WHERE ${clauses.join(' AND ')}
         ORDER BY generated_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...params, limit);
    sendJson(res, 200, { serviceDate, terminalId, eventType, rows });
  });

  router.get('/interventions', (req, res) => {
    // All queue reads are scoped to the currently active service date, including after midnight.
    const serviceDate = activeServiceDate(
      new Date(),
      getServiceDayStart(deps.db),
      deps.getConfig().agencyTimezone,
    );
    const terminalId = typeof req.query.terminalId === 'string' ? req.query.terminalId : undefined;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const interventions = terminalId
      ? deps.interventions.listForTerminal(serviceDate, terminalId)
      : deps.interventions.listForServiceDate(serviceDate);
    sendJson(
      res,
      200,
      status
        ? interventions.filter((item) => item.status === (status as InterventionStatus))
        : interventions,
    );
  });

  router.get('/interventions/:id', (req, res) => {
    try {
      sendJson(res, 200, deps.interventions.require(req.params.id));
    } catch (err) {
      sendJson(res, err instanceof InterventionConflictError ? 404 : 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  const action = async (
    actionName: 'view' | 'apply' | 'decline' | 'cancel',
    req: Request,
    res: Response,
  ): Promise<void> => {
    // Validate every lifecycle command before it reaches SQLite; this also gives clients a stable 400.
    const parsed = interventionActionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendJson(res, 400, { error: parsed.error.flatten() });
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    try {
      const actor = { actorId: parsed.data.actorId, requestId: parsed.data.requestId };
      const intervention = actionName === 'view'
        ? deps.interventions.view(req.params.id, actor, now)
        : actionName === 'apply'
          ? deps.interventions.apply(req.params.id, actor, now)
          : actionName === 'decline'
            ? deps.interventions.decline(req.params.id, actor, now)
            : deps.interventions.cancel(req.params.id, actor, now);
      if (actionName !== 'view') {
        // Applying or resolving a hold changes the engine view, so refresh before replying when possible.
        try {
          await deps.refreshOnce();
        } catch (err) {
          console.error('intervention refresh failed:', err instanceof Error ? err.message : err);
        }
      }
      sendJson(res, 200, intervention);
    } catch (err) {
      sendJson(res, err instanceof InterventionConflictError ? 409 : 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  router.post('/interventions/:id/view', (req, res) => {
    void action('view', req, res);
  });
  router.post('/interventions/:id/apply', (req, res) => {
    void action('apply', req, res);
  });
  router.post('/interventions/:id/decline', (req, res) => {
    void action('decline', req, res);
  });
  router.post('/interventions/:id/cancel', (req, res) => {
    void action('cancel', req, res);
  });

  router.get('/terminals', (_req, res) => {
    const config = deps.getConfig();
    const serviceDayStart = getServiceDayStart(deps.db);
    const now = new Date();
    const nowSvc = nowServiceSeconds(now, serviceDayStart, config.agencyTimezone);
    const activeIds = activeServiceIds(
      deps.db,
      activeServiceDate(now, serviceDayStart, config.agencyTimezone),
    );
    // A terminal is active for a route when that route has an endpoint event (departure as first
    // stop or arrival as last stop) now−30m … now+lookahead. One batched query covers every
    // terminal stop, then each terminal unions the routes of its own stops.
    const fromSvc = nowSvc - ACTIVITY_LOOKBACK_SECONDS;
    const toSvc = nowSvc + config.lookaheadMinutes * 60;
    const allStopIds = Array.from(new Set(config.terminals.flatMap((terminal) => terminal.stopIds)));
    const activeByStop = activeRoutesByStop(deps.db, allStopIds, activeIds, fromSvc, toSvc);
    const activeRoutesFor = (stopIds: string[]): Set<string> => {
      const active = new Set<string>();
      for (const stopId of stopIds) {
        for (const routeId of activeByStop.get(stopId) ?? []) active.add(routeId);
      }
      return active;
    };
    const routes = new Map<string, {
      shortName: string;
      longName?: string;
      color?: string;
      textColor?: string;
      terminalIds: string[];
      inactiveTerminalIds: string[];
    }>();
    // Group terminals by route for the home screen, splitting each route's terminals into the
    // ones active at this moment and the ones off duty while retaining the full configured list.
    for (const terminal of config.terminals) {
      const routeIds = terminal.routeIds ?? routeIdsForTerminal(deps.db, terminal.stopIds);
      const active = activeRoutesFor(terminal.stopIds);
      for (const routeId of routeIds) {
        let entry = routes.get(routeId);
        if (!entry) {
          const style = routeStyle(deps.db, routeId);
          entry = {
            shortName: style.shortName,
            longName: style.longName,
            color: style.color,
            textColor: style.textColor,
            terminalIds: [],
            inactiveTerminalIds: [],
          };
          routes.set(routeId, entry);
        }
        const bucket = active.has(routeId) ? entry.terminalIds : entry.inactiveTerminalIds;
        if (!bucket.includes(terminal.id)) bucket.push(terminal.id);
      }
    }
    const entries = Array.from(routes.entries()).map(([routeId, entry]) => ({
      routeId,
      shortName: entry.shortName,
      longName: entry.longName,
      color: entry.color,
      textColor: entry.textColor,
      terminalIds: entry.terminalIds,
      inactiveTerminalIds: entry.inactiveTerminalIds,
    }));
    entries.sort(byRouteName);
    sendJson(res, 200, { terminals: config.terminals, routes: entries });
  });

  router.get('/terminals/:id', async (req, res) => {
    // Compute-on-miss is awaited inside the handler; Express 4 does not catch async
    // rejections, so engine failures surface as an explicit 500 rather than a hung request.
    let snapshot: TerminalSnapshot | undefined;
    try {
      snapshot = await deps.computeTerminal(req.params.id);
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (!snapshot) {
      sendJson(res, 404, { error: `unknown terminal ${req.params.id}` });
      return;
    }
    const route = req.query.route as string | undefined;
    if (route) {
      sendJson(res, 200, {
        ...snapshot,
        routes: snapshot.routes.filter((r) => r.routeId === route),
      });
      return;
    }
    sendJson(res, 200, snapshot);
  });

  router.get('/terminals/:id/map', async (req, res) => {
    // Read-only debug projection of the terminal's geofences and live vehicle arrows. The payload
    // is re-validated at the boundary so a server-side regression surfaces as a 500, not bad data.
    let map: TerminalMapSnapshot | undefined;
    try {
      map = await deps.computeTerminalMap(req.params.id);
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (!map) {
      sendJson(res, 404, { error: `unknown terminal ${req.params.id}` });
      return;
    }
    sendJson(res, 200, terminalMapSnapshotSchema.parse(map));
  });

  router.get('/terminals/:id/vehicles/:tripId', async (req, res) => {
    // Read-only vehicle card projection over latestRt + the cached snapshot. A 404 covers an
    // unknown terminal, a trip absent from static, or a trip with no presence at the terminal.
    let detail: VehicleDetail | undefined;
    try {
      detail = await deps.computeVehicleDetail(req.params.id, req.params.tripId);
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (!detail) {
      sendJson(res, 404, { error: `no live data for trip ${req.params.tripId} at terminal ${req.params.id}` });
      return;
    }
    sendJson(res, 200, vehicleDetailSchema.parse(detail));
  });

  router.get('/blocks/:blockId', async (req, res) => {
    // Read-only block timeline for the active service date; unknown blocks 404.
    let timeline: BlockTimeline | undefined;
    try {
      timeline = await deps.computeBlockTimeline(req.params.blockId);
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (!timeline) {
      sendJson(res, 404, { error: `unknown block ${req.params.blockId}` });
      return;
    }
    sendJson(res, 200, blockTimelineSchema.parse(timeline));
  });

  router.get('/config', (_req, res) => {
    sendJson(res, 200, redactConfig(deps.getConfig()));
  });

  router.put('/config', (req, res) => {
    // Zod validation happens at the API boundary before persistence or audit logging.
    const parsed = appConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      sendJson(res, 400, { error: parsed.error.flatten() });
      return;
    }
    const config = deps.applyConfig(parsed.data);
    recordConfigEvent(
      deps.db,
      config,
      req.header('x-actor-id') ?? 'anonymous',
      req.header('x-request-id') ?? undefined,
    );
    sendJson(res, 200, redactConfig(config));
  });

  router.post('/static/reload', async (_req, res) => {
    // A static reload refreshes both the schedule tables and the derived live snapshot.
    try {
      await deps.reloadStatic();
      await deps.refreshOnce();
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
