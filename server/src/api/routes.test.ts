import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { createDatabase } from '../db/schema';
import { createApi, type ApiDeps } from './routes';
import { InterventionStore } from '../db/interventions';
import { activeServiceDate, getServiceDayStart } from '../gtfs/time';
import type { AppConfig, TerminalSnapshot } from '../../../shared/types';

// API tests use an in-memory database and real HTTP requests to cover validation, redaction,
// service-date scoping, and intervention lifecycle responses without external feeds.
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
  const interventions = new InterventionStore(db);
  db.exec(`INSERT INTO routes (route_id, agency_id, short_name, long_name, type, color, text_color) VALUES ('1','A','10','Route Ten',3,'FFB81C','000000')`);
  db.exec(`INSERT INTO routes (route_id, agency_id, short_name, long_name, type, color) VALUES ('2','A','2','Route Two',3,'C8102E')`);
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
    getVpDiagnostics: () => ({ observations: [], recentFacts: [] }),
    reloadStatic: () => Promise.resolve(),
    refreshOnce: () => Promise.resolve(),
    interventions,
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

  it('serves read-only VP diagnostics', async () => {
    const base = await startServer(makeDeps({
      getVpDiagnostics: () => ({ observations: [{ vehicleId: 'V1' }], recentFacts: [] }),
    }));
    const res = await fetch(`${base}/diagnostics/vp`);
    expect(res.status).toBe(200);
    expect((await res.json() as { observations: Array<{ vehicleId: string }> }).observations[0]!.vehicleId).toBe('V1');
  });

  it('lists terminals grouped by route, sorted numerically, with colors', async () => {
    const base = await startServer(makeDeps());
    const res = await fetch(`${base}/terminals`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { terminals: unknown[]; routes: Array<{ routeId: string; shortName: string; longName?: string; color?: string; textColor?: string; terminalIds: string[] }> };
    expect(body.terminals).toHaveLength(2);
    expect(body.routes.map((r) => r.routeId)).toEqual(['2', '1']);
    const route1 = body.routes.find((r) => r.routeId === '1')!;
    expect(route1.shortName).toBe('10');
    expect(route1.longName).toBe('Route Ten');
    expect(route1.color).toBe('FFB81C');
    expect(route1.textColor).toBe('000000');
    expect(route1.terminalIds).toEqual(['T1']);
    const route2 = body.routes.find((r) => r.routeId === '2')!;
    expect(route2.shortName).toBe('2');
    expect(route2.color).toBe('C8102E');
    expect(route2.terminalIds).toEqual(['T2']);
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

  it('lists and transitions persistent interventions', async () => {
    const deps = makeDeps();
    const serviceDate = activeServiceDate(new Date(), getServiceDayStart(deps.db));
    const now = Math.floor(Date.now() / 1000);
    const intervention = deps.interventions.createSuggestion({
      id: `hold:${serviceDate}:T1:1:D1`,
      serviceDate,
      terminalId: 'T1',
      routeId: '1',
      rule: 'hold',
      tripId: 'D1',
      holdSeconds: 90,
      reason: 'uneven headways',
      until: 900,
      generatedAt: now,
      expiresAt: now + 3600,
    });
    const base = await startServer(deps);
    const list = await fetch(`${base}/interventions`);
    expect(list.status).toBe(200);
    expect((await list.json()) as unknown[]).toHaveLength(1);

    const viewed = await fetch(`${base}/interventions/${intervention.id}/view`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actorId: 'manager-1', requestId: 'view-1' }),
    });
    expect(viewed.status).toBe(200);
    const applied = await fetch(`${base}/interventions/${intervention.id}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actorId: 'manager-1', requestId: 'apply-1' }),
    });
    expect(applied.status).toBe(200);
    expect((await applied.json() as { status: string }).status).toBe('applied');
  });

  it('returns the append-only run events log, filterable by terminal', async () => {
    const deps = makeDeps();
    const now = Math.floor(Date.now() / 1000);
    deps.db.prepare(
      `INSERT INTO run_events
         (service_date, event_type, trip_id, vehicle_id, terminal_id, route_id, source,
          value_seconds, generated_at, classification, edt_seconds,
          scheduled_departure, scheduled_arrival, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('20260813', 'arrival', 'D1', 'V1', 'T1', '1', 'vp', 1000, now, 'layover', 1100, 1200, 900, now);
    const base = await startServer(deps);
    const all = await fetch(`${base}/run-events?serviceDate=20260813`);
    expect(all.status).toBe(200);
    const body = (await all.json()) as { rows: Array<{ trip_id: string; event_type: string }> };
    expect(body.rows.some((r) => r.trip_id === 'D1' && r.event_type === 'arrival')).toBe(true);

    const filtered = await fetch(`${base}/run-events?serviceDate=20260813&terminalId=T1&type=departure`);
    expect((await filtered.json() as { rows: unknown[] }).rows).toEqual([]);
  });
});
