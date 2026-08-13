import 'dotenv/config';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
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
  nowServiceSeconds,
} from './gtfs/time';
import type { AppConfig, TerminalSnapshot } from '../../shared/types';
import type { RealtimeSnapshot } from './providers/types';

const PORT = Number(process.env.PORT ?? 8080);
const DB_PATH = process.env.DB_PATH ?? './data/dispatch.db';
const STATIC_GTFS_PATH = process.env.STATIC_GTFS_PATH ?? './data/gtfs.zip';

const db = createDatabase(DB_PATH);
let config: AppConfig = loadConfig(db, process.env);

const engine = new Engine(db, () => config);
const provider = new GtfsRealtimeProvider(() => config.realtime);

let snapshots: TerminalSnapshot[] = [];
let lastRefreshAt: number | null = null;
let staticLoadedAt: number | null = getStaticLoadedAt(db);
let broadcaster: { broadcast(snapshots: TerminalSnapshot[]): void } | null = null;

async function ensureStaticLoaded(force = false): Promise<void> {
  const stopCount = (db.prepare('SELECT COUNT(*) AS c FROM stops').get() as { c: number }).c;
  const savedLoadedAt = getStaticLoadedAt(db);
  const stale =
    savedLoadedAt !== null &&
    config.staticRefreshHours > 0 &&
    Date.now() - savedLoadedAt > config.staticRefreshHours * 3600 * 1000;
  if (!force && stopCount > 0 && !stale) return;

  const providerInstance = new GtfsStaticProvider({
    url: config.staticGtfsUrl,
    cachePath: STATIC_GTFS_PATH,
    force,
  });
  const gtfs = await providerInstance.load();
  loadStatic(db, gtfs);
  staticLoadedAt = getStaticLoadedAt(db);

  if (config.terminals.length === 0) {
    const serviceDayStart = getServiceDayStart(db);
    const now = new Date();
    const active = activeServiceIds(db, activeServiceDate(now, serviceDayStart));
    const terminals = autoDiscoverTerminals(db, active);
    if (terminals.length > 0) {
      config = applyConfig(db, config, { ...config, terminals });
    }
  }
}

async function refreshOnce(): Promise<void> {
  const rt: RealtimeSnapshot = await provider.fetch();
  const refreshed = engine.refresh(rt);
  snapshots = refreshed;
  lastRefreshAt = Date.now();
  broadcaster?.broadcast(snapshots);
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
    getSnapshots: () => snapshots,
    getSnapshot: (terminalId) => snapshots.find((s) => s.terminalId === terminalId),
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
broadcaster = setupWs(httpServer, { getSnapshots: () => snapshots });

httpServer.listen(PORT, () => {
  console.log(`dispatch listening on :${PORT}`);
  ensureStaticLoaded()
    .catch((err: unknown) => {
      console.error('static load failed:', err instanceof Error ? err.message : err);
    })
    .finally(() => scheduleRefresh());
});
