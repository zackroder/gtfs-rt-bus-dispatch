import type { AppConfig, Terminal, TerminalSnapshot } from '../../shared/types';

export interface TerminalsResponse {
  terminals: Terminal[];
  routes: Array<{ routeId: string; shortName: string; terminalIds: string[] }>;
}

export interface Health {
  ok: boolean;
  lastRefreshAt: number | null;
  staticLoadedAt: number | null;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export function getHealth(): Promise<Health> {
  return request('/api/health');
}

export function getTerminals(): Promise<TerminalsResponse> {
  return request('/api/terminals');
}

export function getTerminal(id: string, route?: string): Promise<TerminalSnapshot> {
  const query = route ? `?route=${encodeURIComponent(route)}` : '';
  return request(`/api/terminals/${encodeURIComponent(id)}${query}`);
}

export function getConfig(): Promise<AppConfig> {
  return request('/api/config');
}

export function putConfig(config: AppConfig): Promise<AppConfig> {
  return request('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
}

export function reloadStatic(): Promise<{ ok: boolean }> {
  return request('/api/static/reload', { method: 'POST' });
}
