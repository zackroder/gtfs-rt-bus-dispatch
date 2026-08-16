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
import type { AppConfig, TerminalSnapshot } from '../../shared/types';
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
  staticLoadInFlight = ensureStaticLoadedInternal(force).finally(() => {
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
  if (!force && stopCount > 0 && !stale) {
    // Static tables are reusable until their configured refresh age is exceeded.
    discoverTerminals();
    return;
  }

  const providerInstance = new GtfsStaticProvider({
    url: config.staticGtfsUrl,
    cachePath: STATIC_GTFS_PATH,
    force,
  });
  const gtfs = await providerInstance.load();
  loadStatic(db, gtfs);
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
  if (staticLoadInFlight) await staticLoadInFlight;
  try {
    latestRt = await provider.fetch();
  } catch (err) {
    console.error('realtime fetch failed:', err instanceof Error ? err.message : err);
  }
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
    interventions,
    getVpDiagnostics: () => ({
      generatedAt: Math.floor(Date.now() / 1000),
      latestPollAt: latestRt?.timestamp ?? null,
      latestPollAgeSeconds: latestRt ? Math.max(0, Math.floor(Date.now() / 1000) - latestRt.timestamp) : null,
      observations: engine.getVehiclePositionDiagnostics(),
      recentFacts: engine.getFactEventDiagnostics(),
      provider: provider.getDiagnostics(),
    }),
    getHealth: () => ({ ok: true, lastRefreshAt, staticLoadedAt }),
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
  console.log(`dispatch listening on :${PORT}`);
  ensureStaticLoaded()
    .catch((err: unknown) => {
      console.error('static load failed:', err instanceof Error ? err.message : err);
    })
    .finally(() => {
      scheduleRefresh();
      void refreshOnce().catch(() => undefined);
    });
});
