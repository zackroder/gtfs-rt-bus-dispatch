import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import dotenv from 'dotenv';
import express from 'express';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
import { createDatabase } from './db/schema';
import { applyConfig, loadConfig } from './config';
import { loadStatic } from './db/staticLoader';
import { GtfsStaticProvider } from './gtfs/static';
import { GtfsRealtimeProvider } from './providers/gtfsrt';
import { Engine } from './engine/engine';
import { autoDiscoverTerminals } from './engine/terminal';
import { createApi } from './api/routes';
import { setupWs } from './api/ws';
import { InterventionStore } from './db/interventions';
import {
  activeServiceDate,
  activeServiceIds,
  getServiceDayStart,
  getStaticLoadedAt,
} from './gtfs/time';
import type { AppConfig, TerminalMapSnapshot, TerminalSnapshot } from '../../shared/types';
import type { RealtimeSnapshot } from './providers/types';

// The process owns one database, provider, engine, and refresh loop. HTTP and WS layers
// call into these shared objects so snapshots and operational state stay consistent.
const PORT = Number(process.env.PORT ?? 8080);
const DB_PATH = process.env.DB_PATH ?? './data/dispatch.db';
const STATIC_GTFS_PATH = process.env.STATIC_GTFS_PATH ?? './data/gtfs.zip';

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function discoverTerminals(): void {
  // Discovery is only a first-run convenience; an explicit terminal configuration is preserved.
  if (config.terminals.length > 0) return;
  const serviceDayStart = getServiceDayStart(db);
  const now = new Date();
  const active = activeServiceIds(db, activeServiceDate(now, serviceDayStart));
  const terminals = autoDiscoverTerminals(db, active);
  if (terminals.length > 0) {
    config = applyConfig(db, config, { ...config, terminals });
  }
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

async function ensureStaticLoadedInternal(force = false): Promise<void> {
  const stopCount = (db.prepare('SELECT COUNT(*) AS c FROM stops').get() as { c: number }).c;
  const savedLoadedAt = getStaticLoadedAt(db);
  const stale =
    savedLoadedAt !== null &&
    config.staticRefreshHours > 0 &&
    Date.now() - savedLoadedAt > config.staticRefreshHours * 3600 * 1000;
  console.log(`[static] inspect stops=${stopCount} saved_loaded_at=${savedLoadedAt ?? 'none'} stale=${stale}`);
  if (!force && stopCount > 0 && !stale) {
    // Static tables are reusable until their configured refresh age is exceeded.
    discoverTerminals();
    console.log(`[static] reuse terminals=${config.terminals.length}`);
    return;
  }

  const providerInstance = new GtfsStaticProvider({
    url: config.staticGtfsUrl,
    cachePath: STATIC_GTFS_PATH,
    force,
  });
  console.log(`[static] load source=${config.staticGtfsUrl} cache=${STATIC_GTFS_PATH}`);
  const gtfs = await providerInstance.load();
  console.log(
    `[static] parsed stops=${gtfs.stops.length} routes=${gtfs.routes.length} ` +
      `trips=${gtfs.trips.length} stop_times=${gtfs.stopTimes.length}`,
  );
  const persistStartedAt = Date.now();
  loadStatic(db, gtfs);
  console.log(`[static] persisted duration_ms=${Date.now() - persistStartedAt}`);
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // ignore checkpoint failures
  }
  engine.invalidateStaticCaches();
  staticLoadedAt = getStaticLoadedAt(db);
  discoverTerminals();
}

function computeTerminal(terminalId: string): TerminalSnapshot | undefined {
  // HTTP reads can serve the latest cached snapshot, while an unknown configured terminal
  // still returns undefined so the API can distinguish it from an empty snapshot.
  const cached = snapshots.get(terminalId);
  if (cached) return cached;
  if (!config.terminals.some((terminal) => terminal.id === terminalId)) return undefined;
  return {
    terminalId,
    generatedAt: 0,
    serviceDayStartSeconds: getServiceDayStart(db),
    routes: [],
  };
}

function computeTerminalMap(terminalId: string): TerminalMapSnapshot | undefined {
  // The map is derived from the last cached snapshot plus the retained raw feed, so it is
  // read-only by construction and 404s for unknown terminals like the snapshot endpoint. An
  // empty feed still renders the geofence circles, so only missing terminals return undefined.
  const snapshot = computeTerminal(terminalId);
  if (!snapshot) return undefined;
  const rt = latestRt ?? { timestamp: 0, tripUpdates: [], vehiclePositions: [] };
  return engine.buildMapSnapshot(terminalId, snapshot, rt);
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

async function refreshInternal(): Promise<void> {
  const startedAt = Date.now();
  console.log(`[refresh] begin subscribed=${subscriptions.size}`);
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
    // The engine always records facts globally, but only builds snapshots for subscribed terminals.
    const wanted = new Set(subscriptions.keys());
    const fresh = engine.refresh(latestRt, new Date(), wanted);
    for (const snapshot of fresh) snapshots.set(snapshot.terminalId, snapshot);
    for (const terminalId of wanted) {
      if (!fresh.some((snapshot) => snapshot.terminalId === terminalId)) snapshots.delete(terminalId);
    }
    lastRefreshAt = Date.now();
    broadcaster?.broadcast(fresh);
    console.log(`[refresh] complete duration_ms=${Date.now() - startedAt} snapshots=${fresh.length}`);
  } catch (err) {
    lastRefreshError = errorMessage(err);
    console.error(`[refresh] engine failed error=${lastRefreshError}`);
    throw err;
  } finally {
    lastRefreshDurationMs = Date.now() - startedAt;
    if (serverPhase === 'refreshing') serverPhase = 'ready';
    console.log(`[refresh] end duration_ms=${lastRefreshDurationMs}`);
  }
}

async function refreshOnce(): Promise<void> {
  // Serialization prevents overlapping polls from racing the in-memory ledger or broadcasts.
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = refreshInternal().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

function scheduleRefresh(): void {
  const intervalMs = config.refreshIntervalSeconds * 1000;
  setTimeout(() => {
    // Schedule the next tick after this one settles so slow feeds cannot create overlapping loops.
    refreshOnce()
      .catch((err: unknown) => {
        console.error('refresh failed:', err instanceof Error ? err.message : err);
      })
      .finally(() => scheduleRefresh());
  }, intervalMs);
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
      config = applyConfig(db, config, next);
      return config;
    },
    computeTerminal,
    computeTerminalMap,
    interventions,
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
      scheduleRefresh();
      void refreshOnce().catch(() => undefined);
    });
});
