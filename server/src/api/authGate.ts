import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Site-wide HTTP basic-auth gate (deployment plan Phase 11).
 *
 * When `DISPATCH_TOKEN` is set, one shared token is the password for the whole
 * site: the SPA, every `/api` route, and the WebSocket handshake. The token may
 * be supplied as an `Authorization: Basic` password (any username) or via the
 * pre-existing `x-dispatch-token` header, so curl/PowerShell scripts keep
 * working unchanged. An unset token leaves the gate open for local development.
 */

/** Constant-time string comparison. `timingSafeEqual` throws on a length mismatch, so unequal
 *  lengths compare a buffer against itself first to avoid an exception-driven timing signal. */
export function constantTimeEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * Extract the password from a Basic Authorization header. Any username is accepted: the shared
 * token is the only credential. Returns null for an absent or malformed header, which the caller
 * treats as unauthenticated.
 */
export function basicAuthPassword(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  // Node's base64 decoder ignores invalid characters instead of throwing, so a malformed payload
  // degrades to garbage that cannot equal the token (with no colon it is rejected below).
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 0) return null;
  return decoded.slice(separator + 1);
}

/** True for the `/api` subtree (the shape that must not trigger a browser auth dialog). */
function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

/** True only for the single route Fly's credential-less health check probes. */
function isHealthCheck(req: Request): boolean {
  return req.method === 'GET' && req.path === '/api/health';
}

// Accept either credential form; both compares are constant-time.
function isAuthorized(req: Request, token: string): boolean {
  const headerToken = req.header('x-dispatch-token');
  if (headerToken !== undefined && constantTimeEquals(headerToken, token)) return true;
  const password = basicAuthPassword(req.header('authorization'));
  return password !== null && constantTimeEquals(password, token);
}

// /api callers (fetch/XHR) get a plain JSON 401 with no WWW-Authenticate, so the browser never
// pops a dialog for background requests; page/asset loads get the header that triggers the native
// prompt and caches the credentials for the session.
function reject(req: Request, res: Response): void {
  if (isApiPath(req.path)) {
    res.status(401).json({ error: 'authentication required' });
    return;
  }
  res.set('WWW-Authenticate', 'Basic realm="dispatch"');
  res.status(401).send('Authentication required');
}

export interface AuthGateOptions {
  /** Shared token; undefined leaves the gate a no-op (local dev, existing tests unchanged). */
  token: string | undefined;
}

/** Build the site-wide gate middleware. Register it before `createApi`, `express.static`, and the
 *  SPA fallback so it covers every inbound path (the WS upgrade is gated separately in `ws.ts`). */
export function createAuthGate({ token }: AuthGateOptions): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    if (!token) {
      next();
      return;
    }
    // Exempt exactly one route: Fly's health check probes it without credentials, and gating it
    // would mark the machine unhealthy and unroute the app (the failure Phase 10 fixed).
    if (isHealthCheck(req)) {
      next();
      return;
    }
    if (isAuthorized(req, token)) {
      next();
      return;
    }
    reject(req, res);
  };
}
