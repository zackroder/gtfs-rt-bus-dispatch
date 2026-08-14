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
import {
  activeServiceDate,
  activeServiceIds,
  getServiceDayStart,
  getStaticLoadedAt,
} from './gtfs/time';
import type { AppConfig, TerminalSnapshot } from '../../shared/types';
import type { RealtimeSnapshot } from './providers/types';

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

const engine = new Engine(db, () => config);
const provider = new GtfsRealtimeProvider(() => config.realtime);

let latestRt: RealtimeSnapshot | null = null;
const snapshots = new Map<string, TerminalSnapshot>();
const subscriptions = new Map<string, number>();
let lastRefreshAt: number | null = null;
let staticLoadedAt: number | null = getStaticLoadedAt(db);
let broadcaster: { broadcast(snapshots: TerminalSnapshot[]): void } | null = null;

function discoverTerminals(): void {
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
  const stopCount = (db.prepare('SELECT COUNT(*) AS c FROM stops').get() as { c: number }).c;
  const savedLoadedAt = getStaticLoadedAt(db);
  const stale =
    savedLoadedAt !== null &&
    config.staticRefreshHours > 0 &&
    Date.now() - savedLoadedAt > config.staticRefreshHours * 3600 * 1000;
  if (!force && stopCount > 0 && !stale) {
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
  if (!latestRt) return snapshots.get(terminalId);
  const fresh = engine.refresh(latestRt, new Date(), new Set([terminalId]));
  const snapshot = fresh[0];
  if (snapshot) snapshots.set(terminalId, snapshot);
  return snapshot ?? snapshots.get(terminalId);
}

function subscribe(terminalId: string): void {
  const count = (subscriptions.get(terminalId) ?? 0) + 1;
  subscriptions.set(terminalId, count);
  if (count === 1) {
    const snapshot = computeTerminal(terminalId);
    if (snapshot) broadcaster?.broadcast([snapshot]);
  }
}

function unsubscribe(terminalId: string): void {
  const count = (subscriptions.get(terminalId) ?? 0) - 1;
  if (count <= 0) {
    subscriptions.delete(terminalId);
    snapshots.delete(terminalId);
  } else {
    subscriptions.set(terminalId, count);
  }
}

async function refreshOnce(): Promise<void> {
  try {
    latestRt = await provider.fetch();
  } catch (err) {
    console.error('realtime fetch failed:', err instanceof Error ? err.message : err);
  }
  if (!latestRt) return;
  const wanted = new Set(subscriptions.keys());
  const fresh = engine.refresh(latestRt, new Date(), wanted);
  for (const snapshot of fresh) snapshots.set(snapshot.terminalId, snapshot);
  lastRefreshAt = Date.now();
  broadcaster?.broadcast(fresh);
}

function scheduleRefresh(): void {
  const intervalMs = config.refreshIntervalSeconds * 1000;
  setTimeout(() => {
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
  getSnapshots: () => Array.from(snapshots.values()),
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
