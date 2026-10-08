import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { basicAuthPassword, constantTimeEquals, createAuthGate } from './authGate';

// The site gate is exercised over real HTTP so the response shapes (status, WWW-Authenticate,
// and JSON vs. page bodies) match what browsers and fetch/XHR clients actually receive.
const TOKEN = 'sekrit-token';

let server: Server | null = null;
let webRoot: string | null = null;

function basicHeader(password: string, username = 'dispatcher'): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

// Build a miniature site: gate first, then an /api stub, static assets, and the SPA fallback —
// the same ordering as index.ts.
async function startGate(token: string | undefined): Promise<string> {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-gate-'));
  webRoot = dist;
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>app</title>');
  fs.writeFileSync(path.join(dist, 'app.js'), 'console.log(1);');

  const app = express();
  app.use(createAuthGate({ token }));
  app.use('/api', (_req, res) => {
    res.json({ ok: true });
  });
  app.use(express.static(dist));
  app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));

  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

afterEach(() => {
  if (server) {
    server.close();
    server = null;
  }
  if (webRoot) {
    fs.rmSync(webRoot, { recursive: true, force: true });
    webRoot = null;
  }
});

describe('constantTimeEquals', () => {
  it('matches equal values and rejects unequal values or lengths', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
    expect(constantTimeEquals('abc', 'abcd')).toBe(false);
    expect(constantTimeEquals('', '')).toBe(true);
  });
});

describe('basicAuthPassword', () => {
  it('accepts any username and returns the password', () => {
    expect(basicAuthPassword(basicHeader(TOKEN, 'whoever'))).toBe(TOKEN);
    // An empty password is a valid parse (and simply will not match a real token).
    expect(basicAuthPassword(`Basic ${Buffer.from('user:').toString('base64')}`)).toBe('');
  });

  it('rejects absent, non-Basic, and malformed headers', () => {
    expect(basicAuthPassword(undefined)).toBeNull();
    expect(basicAuthPassword('Bearer abc')).toBeNull();
    expect(basicAuthPassword('Basic')).toBeNull();
    expect(basicAuthPassword('Basic !!!')).toBeNull();
    // Valid base64 but no colon separating username from password.
    expect(basicAuthPassword(`Basic ${Buffer.from('nocolon').toString('base64')}`)).toBeNull();
  });
});

describe('createAuthGate', () => {
  it('rejects credential-less requests: JSON 401 for /api, prompt header for pages and assets', async () => {
    const base = await startGate(TOKEN);

    const api = await fetch(`${base}/api/terminals`);
    expect(api.status).toBe(401);
    // fetch/XHR must not trigger the browser auth dialog.
    expect(api.headers.get('www-authenticate')).toBeNull();
    expect(await api.json()).toEqual({ error: 'authentication required' });

    const spa = await fetch(`${base}/`);
    expect(spa.status).toBe(401);
    expect(spa.headers.get('www-authenticate')).toBe('Basic realm="dispatch"');

    const asset = await fetch(`${base}/app.js`);
    expect(asset.status).toBe(401);
    expect(asset.headers.get('www-authenticate')).toBe('Basic realm="dispatch"');
  });

  it('accepts the correct basic password with any username', async () => {
    const base = await startGate(TOKEN);
    const api = await fetch(`${base}/api/terminals`, {
      headers: { authorization: basicHeader(TOKEN, 'someone-else') },
    });
    expect(api.status).toBe(200);
    const spa = await fetch(`${base}/`, { headers: { authorization: basicHeader(TOKEN) } });
    expect(spa.status).toBe(200);
    const asset = await fetch(`${base}/app.js`, { headers: { authorization: basicHeader(TOKEN) } });
    expect(asset.status).toBe(200);
  });

  it('rejects a wrong basic password and a malformed header', async () => {
    const base = await startGate(TOKEN);
    const wrong = await fetch(`${base}/api/terminals`, {
      headers: { authorization: basicHeader('not-the-token') },
    });
    expect(wrong.status).toBe(401);
    const malformed = await fetch(`${base}/api/terminals`, {
      headers: { authorization: 'Basic !!!' },
    });
    expect(malformed.status).toBe(401);
  });

  it('accepts the x-dispatch-token header on any path (existing scripts unchanged)', async () => {
    const base = await startGate(TOKEN);
    const api = await fetch(`${base}/api/terminals`, { headers: { 'x-dispatch-token': TOKEN } });
    expect(api.status).toBe(200);
    const spa = await fetch(`${base}/`, { headers: { 'x-dispatch-token': TOKEN } });
    expect(spa.status).toBe(200);
  });

  it('exempts GET /api/health with and without credentials', async () => {
    const base = await startGate(TOKEN);
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    expect(
      (await fetch(`${base}/api/health`, { headers: { authorization: basicHeader(TOKEN) } })).status,
    ).toBe(200);
  });

  it('is a no-op when no token is configured', async () => {
    const base = await startGate(undefined);
    expect((await fetch(`${base}/api/terminals`)).status).toBe(200);
    expect((await fetch(`${base}/`)).status).toBe(200);
    expect((await fetch(`${base}/app.js`)).status).toBe(200);
  });
});
