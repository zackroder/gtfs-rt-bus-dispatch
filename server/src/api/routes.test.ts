import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { createDatabase } from '../db/schema';
import { createApi, type ApiDeps } from './routes';
import type { AppConfig, TerminalSnapshot } from '../../../shared/types';

const baseConfig: AppConfig = {
  realtime: {
    tripUpdatesUrl: 'http://localhost/tu.pb',
    apiKey: 'sekrit-key',
  },
  staticGtfsUrl: 'http://localhost/gtfs.zip',
  refreshIntervalSeconds: 10,
  staticRefreshHours: 24,
  minRestMinutes: 5,
  maxHoldMinutes: 10,
  leadTimeMinutes: 5,
  lookaheadMinutes: 90,
  terminals: [
    { id: 'T1', name: 'Terminal 1', stopIds: ['S1'], routeIds: ['1'] },
    { id: 'T2', name: 'Terminal 2', stopIds: ['S2'], routeIds: ['2'] },
  ],
};

let server: Server | null = null;

function makeDeps(overrides: Partial<ApiDeps> = {}): ApiDeps {
  const db = createDatabase(':memory:');
  db.exec(`INSERT INTO routes (route_id, agency_id, short_name, long_name, type) VALUES ('1','A','R1','Route One',3)`);
  let config = baseConfig;
  return {
    db,
    getConfig: () => config,
    applyConfig: (next) => {
      config = { ...next, realtime: { ...next.realtime, apiKey: next.realtime.apiKey ?? config.realtime.apiKey } };
      return config;
    },
    computeTerminal: (id) =>
      id === 'T1'
        ? ({
            terminalId: 'T1',
            generatedAt: 1700000000,
            serviceDayStartSeconds: 0,
            routes: [{ routeId: '1', routeShortName: 'R1', incoming: [], layovers: [], departed: [], interventions: [] }],
          } satisfies TerminalSnapshot)
        : undefined,
    getHealth: () => ({ ok: true, lastRefreshAt: 123, staticLoadedAt: 456 }),
    reloadStatic: () => Promise.resolve(),
    refreshOnce: () => Promise.resolve(),
    ...overrides,
  };
}

async function startServer(deps: ApiDeps): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use('/api', createApi(deps));
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const address = server!.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/api`;
}

afterEach(() => {
  if (server) {
    server.close();
    server = null;
  }
});

describe('api routes', () => {
  it('reports health', async () => {
    const base = await startServer(makeDeps());
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, lastRefreshAt: 123, staticLoadedAt: 456 });
  });

  it('lists terminals grouped by route', async () => {
    const base = await startServer(makeDeps());
    const res = await fetch(`${base}/terminals`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { terminals: unknown[]; routes: Array<{ routeId: string; shortName: string; terminalIds: string[] }> };
    expect(body.terminals).toHaveLength(2);
    const route1 = body.routes.find((r) => r.routeId === '1');
    expect(route1!.shortName).toBe('R1');
    expect(route1!.terminalIds).toEqual(['T1']);
  });

  it('serves a terminal snapshot and supports route filtering', async () => {
    const base = await startServer(makeDeps());
    const res = await fetch(`${base}/terminals/T1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TerminalSnapshot;
    expect(body.terminalId).toBe('T1');

    const filtered = await fetch(`${base}/terminals/T1?route=2`);
    const filteredBody = (await filtered.json()) as TerminalSnapshot;
    expect(filteredBody.routes).toEqual([]);
  });

  it('returns 404 for an unknown terminal', async () => {
    const base = await startServer(makeDeps());
    const res = await fetch(`${base}/terminals/NOPE`);
    expect(res.status).toBe(404);
  });

  it('redacts the api key from GET /config', async () => {
    const base = await startServer(makeDeps());
    const res = await fetch(`${base}/config`);
    const body = (await res.json()) as AppConfig;
    expect(body.realtime.apiKey).toBeUndefined();
    expect(body.realtime.tripUpdatesUrl).toBe(baseConfig.realtime.tripUpdatesUrl);
  });

  it('accepts a valid PUT /config and redacts the response', async () => {
    const base = await startServer(makeDeps());
    const next = { ...baseConfig, minRestMinutes: 12 };
    const res = await fetch(`${base}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AppConfig;
    expect(body.minRestMinutes).toBe(12);
    expect(body.realtime.apiKey).toBeUndefined();
  });

  it('rejects an invalid PUT /config', async () => {
    const base = await startServer(makeDeps());
    const res = await fetch(`${base}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...baseConfig, minRestMinutes: -1 }),
    });
    expect(res.status).toBe(400);
  });
});
