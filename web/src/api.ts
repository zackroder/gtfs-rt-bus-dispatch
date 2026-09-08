/**
 * Browser API client for REST and websocket-adjacent data contracts.
 *
 * Every response is parsed with the shared Zod schema so malformed or stale
 * server data cannot enter React state as if it were a valid DTO.
 */
import {
  appConfigSchema,
  blockTimelineSchema,
  healthSchema,
  interventionSchema,
  staticReloadSchema,
  terminalMapSnapshotSchema,
  terminalSnapshotSchema,
  terminalsResponseSchema,
  vehicleDetailSchema,
  type AppConfig,
  type BlockTimeline,
  type Intervention,
  type Terminal,
  type TerminalMapSnapshot,
  type TerminalSnapshot,
  type VehicleDetail,
} from '../../shared/types';

export interface TerminalsResponse {
  terminals: Terminal[];
  routes: Array<{
    routeId: string;
    shortName: string;
    longName?: string;
    color?: string;
    textColor?: string;
    terminalIds: string[];
  }>;
}

/** Health timestamps are nullable until the corresponding server work runs. */
export interface Health {
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
}

// This deliberately matches the small interface needed by Zod's parse methods.
interface Parser<T> {
  parse(value: unknown): T;
}

async function request<T>(url: string, parser: Parser<T>, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  // A request that outlives the page should not leave the UI waiting forever.
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    // Parsing is part of the request boundary, not an assumption made by callers.
    return parser.parse(await res.json());
  } finally {
    window.clearTimeout(timeout);
  }
}

// Like request, but a 404 resolves to null so callers can treat "no live data for this run" as
// an expected state rather than an error.
async function requestOptional<T>(url: string, parser: Parser<T>): Promise<T | null> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return parser.parse(await res.json());
  } finally {
    window.clearTimeout(timeout);
  }
}

/** Loads process and refresh timestamps used by operational health displays. */
export function getHealth(): Promise<Health> {
  return request('/api/health', healthSchema);
}

/** Loads the configured terminal index and route grouping for navigation. */
export function getTerminals(): Promise<TerminalsResponse> {
  return request('/api/terminals', terminalsResponseSchema);
}

/** Loads one terminal snapshot, optionally narrowed to one route server-side. */
export function getTerminal(id: string, route?: string): Promise<TerminalSnapshot> {
  const query = route ? `?route=${encodeURIComponent(route)}` : '';
  return request(`/api/terminals/${encodeURIComponent(id)}${query}`, terminalSnapshotSchema);
}

/** Loads the read-only debug map for one terminal (geofences + live vehicle arrows). */
export function getTerminalMap(id: string): Promise<TerminalMapSnapshot> {
  return request(`/api/terminals/${encodeURIComponent(id)}/map`, terminalMapSnapshotSchema);
}

/** Loads one vehicle card's read-only detail; a 404 means "no live data for this run". */
export function getVehicleDetail(
  terminalId: string,
  tripId: string,
): Promise<VehicleDetail | null> {
  return requestOptional(
    `/api/terminals/${encodeURIComponent(terminalId)}/vehicles/${encodeURIComponent(tripId)}`,
    vehicleDetailSchema,
  );
}

/** Loads one block's timeline for the active service date; a 404 means an unknown block. */
export function getBlockTimeline(blockId: string): Promise<BlockTimeline | null> {
  return requestOptional(`/api/blocks/${encodeURIComponent(blockId)}`, blockTimelineSchema);
}

/** Reads the complete editable runtime configuration. */
export function getConfig(): Promise<AppConfig> {
  return request('/api/config', appConfigSchema);
}

/** Persists a configuration that has already been represented by the shared type. */
export function putConfig(config: AppConfig): Promise<AppConfig> {
  return request('/api/config', appConfigSchema, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
}

/** Requests an asynchronous refresh of the cached static GTFS dataset. */
export function reloadStatic(): Promise<{ ok: boolean }> {
  return request('/api/static/reload', staticReloadSchema, { method: 'POST' });
}

// These named methods keep UI intent explicit while sharing one action endpoint.
export function viewIntervention(id: string): Promise<Intervention> {
  return interventionAction(id, 'view');
}

export function applyIntervention(id: string): Promise<Intervention> {
  return interventionAction(id, 'apply');
}

export function declineIntervention(id: string): Promise<Intervention> {
  return interventionAction(id, 'decline');
}

export function cancelIntervention(id: string): Promise<Intervention> {
  return interventionAction(id, 'cancel');
}

function interventionAction(
  id: string,
  action: 'view' | 'apply' | 'decline' | 'cancel',
): Promise<Intervention> {
  // The server records this actor value in its intervention audit trail.
  return request(`/api/interventions/${encodeURIComponent(id)}/${action}`, interventionSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actorId: 'anonymous' }),
  });
}
