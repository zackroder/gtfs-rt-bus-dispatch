import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import dotenv from 'dotenv';
import express from 'express';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
import { createDatabase } from './db/schema';
import { applyConfig, getTerminalsSource, loadConfig, setTerminalsSource } from './config';
import { bakedStaticIsStale, refreshStaticFromBaked } from './db/bakedStatic';
import { loadStatic } from './db/staticLoader';
import { GtfsStaticProvider } from './gtfs/static';
import { GtfsRealtimeProvider } from './providers/gtfsrt';
import { Engine } from './engine/engine';
import {
  ACTIVITY_LOOKBACK_SECONDS,
  activeTerminalIds,
  autoDiscoverTerminals,
  discoveryServiceIds,
  filterTerminalsByFocus,
} from './engine/terminal';
import { createApi } from './api/routes';
import { setupWs } from './api/ws';
import { InterventionStore } from './db/interventions';
import { createWatchdog, type Watchdog } from './watchdog';
import {
  activeServiceDate,
  activeServiceIds,
  getServiceDayStart,
  getStaticLoadedAt,
  nowServiceSeconds,
} from './gtfs/time';
import type { AppConfig, BlockTimeline, Terminal, TerminalMapSnapshot, TerminalSnapshot, VehicleDetail } from '../../shared/types';
import type { RealtimeSnapshot } from './providers/types';

// The process owns one database, provider, engine, and refresh loop. HTTP and WS layers
// call into these shared objects so snapshots and operational state stay consistent.
const PORT = Number(process.env.PORT ?? 8080);
const DB_PATH = process.env.DB_PATH ?? './data/dispatch.db';
const STATIC_GTFS_PATH = process.env.STATIC_GTFS_PATH ?? './data/gtfs.zip';
// Optional access control for mutating routes; unset keeps local/dev behavior unchanged.
const DISPATCH_TOKEN = process.env.DISPATCH_TOKEN || undefined;
const parsedStaticCheckSeconds = Number(process.env.STATIC_CHECK_SECONDS);
// How often to re-check static staleness while running; the call no-ops unless the configured
// staticRefreshHours window has elapsed. Env-tunable so the acceptance test can run in minutes.
const STATIC_CHECK_SECONDS =
  Number.isFinite(parsedStaticCheckSeconds) && parsedStaticCheckSeconds > 0
    ? parsedStaticCheckSeconds
    : 3600;
// Baked mode: when set, the runtime never downloads/parses the GTFS zip; it copies the image's
// baked static tables into the volume DB when they are newer (Phase 7b).
const BAKED_STATIC_DB = process.env.BAKED_STATIC_DB || undefined;
const parsedDecisionSeconds = Number(process.env.DECISION_INTERVAL_SECONDS);
// Flat decision cadence (recommendations/run_events/snapshots); facts tick at refreshIntervalSeconds.
const DECISION_INTERVAL_SECONDS =
  Number.isFinite(parsedDecisionSeconds) && parsedDecisionSeconds > 0 ? parsedDecisionSeconds : 30;
const parsedWatchdogSeconds = Number(process.env.WATCHDOG_STALE_SECONDS);
// Emergency self-heal: a refresh that never settles (e.g. a fetch hung past its abort) wedges
// both tick loops, because every tick coalesces onto the in-flight promise. After this many
// seconds without a completed tick the process exits so the platform restart brings the
// collector back. The structural fix is plan Phase 10e; this is the stopgap.
const WATCHDOG_STALE_SECONDS =
  Number.isFinite(parsedWatchdogSeconds) && parsedWatchdogSeconds > 0 ? parsedWatchdogSeconds : 180;

const db = createDatabase(DB_PATH);
try {
  db.pragma('wal_checkpoint(TRUNCATE)');
} catch {
  // ignore if another process holds the WAL
}
let config: AppConfig = loadConfig(db, process.env);

const interventions = new InterventionStore(db);
const engine = new Engine(db, () => config, interventions);
const provider = new GtfsRealtimeProvider(() => config.realtime);

let latestRt: RealtimeSnapshot | null = null;
const snapshots = new Map<string, TerminalSnapshot>();
const subscriptions = new Map<string, number>();
let lastRefreshAt: number | null = null;
// Touched by every completed refresh cycle (fact or decision) and armed at boot after the
// static load settles; see WATCHDOG_STALE_SECONDS for why this exists.
let tickWatchdog: Watchdog | null = null;
let staticLoadedAt: number | null = getStaticLoadedAt(db);
let broadcaster: { broadcast(snapshots: TerminalSnapshot[]): void } | null = null;
let refreshInFlight: Promise<void> | null = null;
let staticLoadInFlight: Promise<void> | null = null;
type ServerPhase = 'starting' | 'loading_static' | 'ready' | 'refreshing' | 'error';
let serverPhase: ServerPhase = staticLoadedAt === null ? 'starting' : 'ready';
let startupError: string | null = null;
let lastRefreshError: string | null = null;
let lastStaticLoadDurationMs: number | null = null;
let lastRefreshDurationMs: number | null = null;
// Baked mode only: volume static data is older than staticRefreshHours and the image carries no
// newer baked tables, so the machine is waiting for the next scheduled deploy (never downloads).
let staticStale = false;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Discovery unions this many service dates so day-of-week terminal variants are all found.
const DISCOVERY_DAYS = 7;

// Compare discovered terminals to the active config by identity and membership, ignoring order.
function terminalsEqual(a: Terminal[], b: Terminal[]): boolean {
  if (a.length !== b.length) return false;
  const signature = (t: Terminal) =>
    `${t.id}|${[...t.stopIds].sort().join(',')}|${[...(t.routeIds ?? [])].sort().join(',')}|${t.name}`;
  const left = a.map(signature).sort();
  const right = b.map(signature).sort();
  return left.every((value, index) => value === right[index]);
}

// Set equality ignoring order/duplicates, for comparing a route-focus list.
function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((value) => set.has(value));
}

function discoverTerminals(): void {
  // A manual terminal configuration is an owner override and is never replaced; in auto mode
  // re-run on every static load (fresh or reuse) so time-of-day variants stay current.
  if (getTerminalsSource(db) === 'manual') return;
  const serviceDayStart = getServiceDayStart(db);
  const now = new Date();
  const serviceDate = activeServiceDate(now, serviceDayStart, config.agencyTimezone);
  const active = discoveryServiceIds(db, serviceDate, DISCOVERY_DAYS);
  // Scope discovery to the configured focus (empty = all routes); this scopes everything
  // downstream because the engine's wanted set derives from config.terminals.
  const terminals = filterTerminalsByFocus(autoDiscoverTerminals(db, active), config.focusRouteIds ?? []);
  if (terminals.length === 0) return;
  if (terminalsEqual(config.terminals, terminals)) return;
  config = applyConfig(db, config, { ...config, terminals });
}

async function ensureStaticLoaded(force = false): Promise<void> {
  // Coalesce concurrent startup, reload, and request-triggered loads into one operation.
  if (staticLoadInFlight) return staticLoadInFlight;
  const startedAt = Date.now();
  serverPhase = 'loading_static';
  startupError = null;
  console.log(`[static] begin force=${force}`);
  staticLoadInFlight = ensureStaticLoadedInternal(force)
    .then(() => {
      serverPhase = 'ready';
      lastStaticLoadDurationMs = Date.now() - startedAt;
      console.log(`[static] ready duration_ms=${lastStaticLoadDurationMs}`);
    })
    .catch((error: unknown) => {
      serverPhase = 'error';
      startupError = errorMessage(error);
      lastStaticLoadDurationMs = Date.now() - startedAt;
      console.error(`[static] failed duration_ms=${lastStaticLoadDurationMs} error=${startupError}`);
      throw error;
    })
    .finally(() => {
      staticLoadInFlight = null;
    });
  return staticLoadInFlight;
}

// Shared post-load steps for both the download/parse path and the baked-copy path: fold the
// WAL, drop schedule-derived engine state (this also cancels stale interventions), refresh the
// loadedAt marker, and re-run discovery (which honours the current focus).
function postStaticLoad(): void {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // ignore checkpoint failures
  }
  engine.invalidateStaticCaches();
  staticLoadedAt = getStaticLoadedAt(db);
  discoverTerminals();
}

async function ensureStaticLoadedInternal(force = false): Promise<void> {
  const stopCount = (db.prepare('SELECT COUNT(*) AS c FROM stops').get() as { c: number }).c;
  const savedLoadedAt = getStaticLoadedAt(db);
  const stale =
    savedLoadedAt !== null &&
    config.staticRefreshHours > 0 &&
    Date.now() - savedLoadedAt > config.staticRefreshHours * 3600 * 1000;
  console.log(
    `[static] inspect stops=${stopCount} saved_loaded_at=${savedLoadedAt ?? 'none'} ` +
      `stale=${stale} baked=${BAKED_STATIC_DB ?? 'none'}`,
  );

  if (BAKED_STATIC_DB) {
    // Baked mode: the GTFS parse never runs on this machine. Copy the image's baked static
    // tables in when they are newer than the volume's; run the post-load steps on success.
    const result = refreshStaticFromBaked(db, BAKED_STATIC_DB, () => postStaticLoad());
    staticStale = bakedStaticIsStale(
      result.copied,
      savedLoadedAt,
      stopCount,
      config.staticRefreshHours,
      Date.now(),
    );
    if (result.copied) {
      console.log(`[static] baked copy loaded_at=${result.bakedLoadedAt}`);
      return;
    }
    if (stopCount > 0) {
      // Volume data is at least as new as the image; reuse it.
      if (staticStale) {
        console.warn(
          `[static] baked stale volume_loaded_at=${savedLoadedAt} ` +
            `baked_loaded_at=${result.bakedLoadedAt ?? 'none'}; awaiting next scheduled deploy`,
        );
      }
      discoverTerminals();
      console.log(`[static] baked reuse terminals=${config.terminals.length}`);
      return;
    }
    // No volume static and no usable baked file: surface staleness instead of downloading (a
    // download here is exactly what OOMs the machine the first day the volume data ages out).
    console.warn('[static] baked file missing and volume empty; not downloading in baked mode');
    return;
  }

  // Non-baked (local dev): the existing download/parse path is unchanged.
  if (!force && stopCount > 0 && !stale) {
    // Static tables are reusable until their configured refresh age is exceeded.
    discoverTerminals();
    console.log(`[static] reuse terminals=${config.terminals.length}`);
    return;
  }

  // Staleness means the cached bytes are what's stale: re-download and replace the cache. A
  // first load (no cache) and an explicit manual reload already fetch from the URL.
  const refreshCache = force || stale;
  const providerInstance = new GtfsStaticProvider({
    url: config.staticGtfsUrl,
    cachePath: STATIC_GTFS_PATH,
    force: refreshCache,
  });
  console.log(
    `[static] load source=${config.staticGtfsUrl} cache=${STATIC_GTFS_PATH} force=${refreshCache}`,
  );
  const gtfs = await providerInstance.load();
  console.log(
    `[static] parsed stops=${gtfs.stops.length} routes=${gtfs.routes.length} ` +
      `trips=${gtfs.trips.length} stop_times=${gtfs.stopTimes.length}`,
  );
  const persistStartedAt = Date.now();
  loadStatic(db, gtfs);
  console.log(`[static] persisted duration_ms=${Date.now() - persistStartedAt}`);
  staticStale = false;
  postStaticLoad();
}

async function ensureTerminal(terminalId: string): Promise<TerminalSnapshot | undefined> {
  // REST reads must not depend on a WS subscriber existing first: serve the cache, then
  // compute on demand for a known terminal before falling back to the empty shell.
  const cached = snapshots.get(terminalId);
  if (cached) return cached;
  if (!config.terminals.some((terminal) => terminal.id === terminalId)) return undefined;
  if (latestRt) {
    // Compute from the retained feed snapshot. engine.refresh is fully synchronous, so this
    // cannot interleave with the scheduled refresh loop mid-cycle, and the fact pass is
    // idempotent (monotonic VP gating) when several misses run back-to-back.
    try {
      const [fresh] = engine.refresh(latestRt, new Date(), new Set([terminalId]));
      if (fresh) snapshots.set(terminalId, fresh);
    } catch (err) {
      console.error(`terminal ${terminalId} compute failed:`, errorMessage(err));
      throw err;
    }
    return snapshots.get(terminalId);
  }
  // No realtime data retained yet (first fetch never completed): run one refresh cycle,
  // which waits for any in-flight static load, then serve whatever it produced.
  try {
    await refreshOnce();
  } catch {
    // Refresh errors are already logged and reflected in health; serve the shell below.
  }
  const afterRefresh = snapshots.get(terminalId);
  if (afterRefresh) return afterRefresh;
  return {
    terminalId,
    generatedAt: 0,
    serviceDayStartSeconds: getServiceDayStart(db),
    routes: [],
  };
}

async function computeTerminalMap(terminalId: string): Promise<TerminalMapSnapshot | undefined> {
  // The map is derived from the computed snapshot plus the retained raw feed, so it is
  // read-only by construction and 404s for unknown terminals like the snapshot endpoint. An
  // empty feed still renders the geofence circles, so only missing terminals return undefined.
  const snapshot = await ensureTerminal(terminalId);
  if (!snapshot) return undefined;
  const rt = latestRt ?? { timestamp: 0, tripUpdates: [], vehiclePositions: [] };
  return engine.buildMapSnapshot(terminalId, snapshot, rt);
}

async function computeVehicleDetail(terminalId: string, tripId: string): Promise<VehicleDetail | undefined> {
  // The vehicle card is a read-only projection of the retained feed plus the cached snapshot;
  // it must never trigger a feed fetch or a refresh cycle.
  const snapshot = await ensureTerminal(terminalId);
  if (!snapshot) return undefined;
  const rt = latestRt ?? { timestamp: 0, tripUpdates: [], vehiclePositions: [] };
  return engine.vehicleDetail(terminalId, tripId, snapshot, rt);
}

async function computeBlockTimeline(blockId: string): Promise<BlockTimeline | undefined> {
  // The block strip is schedule + ledger only, scoped to the active service date.
  return engine.blockTimeline(blockId);
}

function subscribe(terminalId: string): void {
  const count = (subscriptions.get(terminalId) ?? 0) + 1;
  subscriptions.set(terminalId, count);
  if (count === 1) {
    // The first interested client gets an immediate refresh instead of waiting for the timer.
    void refreshOnce().catch((err: unknown) => {
      console.error('subscription refresh failed:', err instanceof Error ? err.message : err);
    });
  }
}

function unsubscribe(terminalId: string): void {
  const count = (subscriptions.get(terminalId) ?? 0) - 1;
  if (count <= 0) {
    // Drop terminal-specific memory once no WS client can consume it.
    subscriptions.delete(terminalId);
    snapshots.delete(terminalId);
  } else {
    subscriptions.set(terminalId, count);
  }
}

// One serialized refresh cycle. Fact ticks (runDecisions=false) record the global fact pass and
// intervention expiry only; decision ticks also build route states, queue recommendations, write
// run_events, and broadcast. Both share the engine's ledger, so they must never overlap.
async function refreshInternal(runDecisions: boolean): Promise<void> {
  const startedAt = Date.now();
  console.log(`[refresh] begin decisions=${runDecisions} subscribed=${subscriptions.size}`);
  try {
    if (staticLoadInFlight) {
      console.log('[refresh] waiting_for_static_load');
      await staticLoadInFlight;
    }
    serverPhase = 'refreshing';
    const fetchStartedAt = Date.now();
    latestRt = await provider.fetch();
    lastRefreshError = null;
    console.log(
      `[refresh] feeds duration_ms=${Date.now() - fetchStartedAt} ` +
        `tu=${latestRt.tripUpdates.length} vp=${latestRt.vehiclePositions.length} ` +
        `vp_cached=${latestRt.vehiclePositionsFromCache === true}`,
    );
  } catch (err) {
    lastRefreshError = errorMessage(err);
    console.error(`[refresh] preparation/feed failed error=${lastRefreshError}`);
  }
  try {
    if (!latestRt) return;
    const now = new Date();
    if (!runDecisions) {
      // Fact tick: an empty wanted set still runs recordFacts (focused terminals) and expiry,
      // but writes no run_events/interventions and produces no snapshots.
      engine.refresh(latestRt, now, new Set());
      console.log(`[facts] complete duration_ms=${Date.now() - startedAt}`);
      return;
    }
    // Evaluate every active terminal on each decision pass so recommendations and run facts
    // accumulate with nobody watching; a user watching an off-duty terminal still gets a snapshot.
    const serviceDayStart = getServiceDayStart(db);
    const nowSvc = nowServiceSeconds(now, serviceDayStart, config.agencyTimezone);
    const active = activeTerminalIds(
      db,
      config.terminals,
      activeServiceIds(db, activeServiceDate(now, serviceDayStart, config.agencyTimezone)),
      nowSvc - ACTIVITY_LOOKBACK_SECONDS,
      nowSvc + config.lookaheadMinutes * 60,
    );
    const wanted = new Set([...active, ...subscriptions.keys()]);
    const fresh = engine.refresh(latestRt, now, wanted);
    for (const snapshot of fresh) snapshots.set(snapshot.terminalId, snapshot);
    for (const terminalId of wanted) {
      if (!fresh.some((snapshot) => snapshot.terminalId === terminalId)) snapshots.delete(terminalId);
    }
    lastRefreshAt = Date.now();
    // Broadcast stays viewer-scoped: only clients watching a terminal receive its snapshot.
    broadcaster?.broadcast(fresh.filter((snapshot) => subscriptions.has(snapshot.terminalId)));
    console.log(
      `[refresh] complete duration_ms=${Date.now() - startedAt} snapshots=${fresh.length} active=${active.size}`,
    );
  } catch (err) {
    lastRefreshError = errorMessage(err);
    console.error(`[refresh] engine failed error=${lastRefreshError}`);
    throw err;
  } finally {
    lastRefreshDurationMs = Date.now() - startedAt;
    if (serverPhase === 'refreshing') serverPhase = 'ready';
    // Warn when a pass eats its cadence: a decision pass over the focused set must fit the flat
    // interval (the signal the focus list has outgrown the machine); a fact pass must fit half.
    const slowThresholdMs = runDecisions
      ? DECISION_INTERVAL_SECONDS * 1000
      : config.refreshIntervalSeconds * 500;
    if (lastRefreshDurationMs > slowThresholdMs) {
      console.warn(
        `[refresh] slow decisions=${runDecisions} duration_ms=${lastRefreshDurationMs} threshold_ms=${slowThresholdMs}`,
      );
    }
    console.log(`[refresh] end decisions=${runDecisions} duration_ms=${lastRefreshDurationMs}`);
    // A cycle that completed (even with an error) proves the loops are alive; a cycle that
    // never settles is exactly the wedge the watchdog exists to recover from.
    tickWatchdog?.touch();
  }
}

// A decision requested while another pass is running is coalesced and run immediately after, so
// a long fact/decision pass can never drop a decision tick entirely.
let decisionRequested = false;

function runRefresh(decisions: boolean): Promise<void> {
  if (decisions) decisionRequested = true;
  if (refreshInFlight) return refreshInFlight;
  const runDecisions = decisionRequested;
  decisionRequested = false;
  refreshInFlight = refreshInternal(runDecisions).finally(() => {
    refreshInFlight = null;
    if (decisionRequested) {
      void runRefresh(true).catch((err: unknown) => {
        console.error('queued refresh failed:', err instanceof Error ? err.message : err);
      });
    }
  });
  return refreshInFlight;
}

// Decision refresh used by WS subscribe, REST compute-on-miss, and intervention actions.
function refreshOnce(): Promise<void> {
  return runRefresh(true);
}

function scheduleFactTick(): void {
  const intervalMs = config.refreshIntervalSeconds * 1000;
  setTimeout(() => {
    // Schedule the next tick after this one settles so slow feeds cannot create overlapping loops.
    runRefresh(false)
      .catch((err: unknown) => {
        console.error('fact tick failed:', err instanceof Error ? err.message : err);
      })
      .finally(() => scheduleFactTick());
  }, intervalMs);
}

function scheduleDecisionTick(): void {
  const intervalMs = DECISION_INTERVAL_SECONDS * 1000;
  setTimeout(() => {
    runRefresh(true)
      .catch((err: unknown) => {
        console.error('decision tick failed:', err instanceof Error ? err.message : err);
      })
      .finally(() => scheduleDecisionTick());
  }, intervalMs);
}

function scheduleStaticCheck(): void {
  // The realtime loop never re-checks static staleness, so a long-running collector would keep
  // serving the day-0 schedule forever. This self-scheduling timer re-runs the (cheap) load
  // guard; it no-ops unless staticRefreshHours has elapsed.
  setTimeout(() => {
    void ensureStaticLoaded(false)
      .catch((err: unknown) => {
        console.error('scheduled static check failed:', err instanceof Error ? err.message : err);
      })
      .finally(() => scheduleStaticCheck());
  }, STATIC_CHECK_SECONDS * 1000);
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api', (req, res, next) => {
  const startedAt = Date.now();
  res.once('finish', () => {
    console.log(`[http] ${req.method} ${req.originalUrl} status=${res.statusCode} duration_ms=${Date.now() - startedAt}`);
  });
  next();
});
app.use(
  '/api',
  createApi({
    db,
    getConfig: () => config,
    applyConfig: (next) => {
      const terminalsChanged = !terminalsEqual(config.terminals, next.terminals);
      const focusChanged = !sameStringSet(config.focusRouteIds ?? [], next.focusRouteIds ?? []);
      config = applyConfig(db, config, next);
      // An explicit terminal-list change is an owner override that disables auto-discovery;
      // unrelated setting saves keep the current source so runtime focus changes can recompute.
      if (terminalsChanged) setTerminalsSource(db, 'manual');
      // A focus change recomputes the auto-discovered terminal list immediately (no restart).
      if (focusChanged && getTerminalsSource(db) === 'auto') discoverTerminals();
      return config;
    },
    computeTerminal: ensureTerminal,
    computeTerminalMap,
    computeVehicleDetail,
    computeBlockTimeline,
    interventions,
    dispatchToken: DISPATCH_TOKEN,
    getVpDiagnostics: () => ({
      generatedAt: Math.floor(Date.now() / 1000),
      latestPollAt: latestRt?.timestamp ?? null,
      latestPollAgeSeconds: latestRt ? Math.max(0, Math.floor(Date.now() / 1000) - latestRt.timestamp) : null,
      observations: engine.getVehiclePositionDiagnostics(),
      recentFacts: engine.getFactEventDiagnostics(),
      provider: provider.getDiagnostics(),
    }),
    getHealth: () => ({
      ok: true,
      tokenRequired: DISPATCH_TOKEN !== undefined,
      staticStale,
      ready: serverPhase === 'ready' || serverPhase === 'refreshing',
      phase: serverPhase,
      staticLoading: staticLoadInFlight !== null,
      refreshInFlight: refreshInFlight !== null,
      startupError,
      lastRefreshError,
      lastStaticLoadDurationMs,
      lastRefreshDurationMs,
      lastRefreshAt,
      staticLoadedAt,
    }),
    reloadStatic: () => ensureStaticLoaded(true),
    refreshOnce,
  }),
);

const webDist = path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => {
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

const httpServer = http.createServer(app);
broadcaster = setupWs(httpServer, {
  subscribe,
  unsubscribe,
});

httpServer.listen(PORT, () => {
  console.log(`dispatch listening on :${PORT} phase=${serverPhase}`);
  ensureStaticLoaded()
    .catch((err: unknown) => {
      console.error('static load failed:', err instanceof Error ? err.message : err);
    })
    .finally(() => {
      // Armed here (after static settles) so a slow boot cannot trip it; the interval matches
      // the fastest loop so a hung cycle is detected within one watchdog window + the stale
      // threshold. Every completed cycle touches it in refreshInternal's finally.
      tickWatchdog = createWatchdog({
        intervalMs: Math.min(config.refreshIntervalSeconds, DECISION_INTERVAL_SECONDS) * 1000,
        staleMs: WATCHDOG_STALE_SECONDS * 1000,
        onStale: (staleSeconds) => {
          console.error(
            `[watchdog] no completed tick for ${staleSeconds}s — a refresh hung ` +
              '(see plan Phase 10e); exiting so the platform restarts the collector',
          );
          process.exit(1);
        },
      });
      scheduleFactTick();
      scheduleDecisionTick();
      scheduleStaticCheck();
      void refreshOnce().catch(() => undefined);
    });
});
