import { Router, type Response } from 'express';
import type { Database } from 'better-sqlite3';
import { appConfigSchema, type AppConfig, type TerminalSnapshot } from '../../../shared/types';
import { redactConfig } from '../config';
import { routeStyle } from '../engine/terminal';

function byRouteName(a: { shortName: string; routeId: string }, b: { shortName: string; routeId: string }): number {
  const nameA = a.shortName || a.routeId;
  const nameB = b.shortName || b.routeId;
  return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
}

export interface ApiDeps {
  db: Database;
  getConfig(): AppConfig;
  applyConfig(next: AppConfig): AppConfig;
  computeTerminal(terminalId: string): TerminalSnapshot | undefined;
  getHealth(): { ok: boolean; lastRefreshAt: number | null; staticLoadedAt: number | null };
  reloadStatic(): Promise<void>;
  refreshOnce(): Promise<void>;
}

function sendJson(res: Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

export function createApi(deps: ApiDeps): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    sendJson(res, 200, deps.getHealth());
  });

  router.get('/terminals', (_req, res) => {
    const config = deps.getConfig();
    const routes = new Map<string, { shortName: string; longName?: string; color?: string; textColor?: string; terminalIds: string[] }>();
    for (const terminal of config.terminals) {
      for (const routeId of terminal.routeIds ?? []) {
        let entry = routes.get(routeId);
        if (!entry) {
          const style = routeStyle(deps.db, routeId);
          entry = {
            shortName: style.shortName,
            longName: style.longName,
            color: style.color,
            textColor: style.textColor,
            terminalIds: [],
          };
          routes.set(routeId, entry);
        }
        if (!entry.terminalIds.includes(terminal.id)) entry.terminalIds.push(terminal.id);
      }
    }
    const entries = Array.from(routes.entries()).map(([routeId, entry]) => ({
      routeId,
      shortName: entry.shortName,
      longName: entry.longName,
      color: entry.color,
      textColor: entry.textColor,
      terminalIds: entry.terminalIds,
    }));
    entries.sort(byRouteName);
    sendJson(res, 200, { terminals: config.terminals, routes: entries });
  });

  router.get('/terminals/:id', (req, res) => {
    const snapshot = deps.computeTerminal(req.params.id);
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

  router.get('/config', (_req, res) => {
    sendJson(res, 200, redactConfig(deps.getConfig()));
  });

  router.put('/config', (req, res) => {
    const parsed = appConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      sendJson(res, 400, { error: parsed.error.flatten() });
      return;
    }
    const config = deps.applyConfig(parsed.data);
    sendJson(res, 200, redactConfig(config));
  });

  router.post('/static/reload', async (_req, res) => {
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
