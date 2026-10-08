import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { setupWs } from './ws';

// The upgrade gate must be driven with a raw HTTP upgrade: an Express middleware never sees
// `upgrade` events, and the ws client would hide the 401 handshake details we need to assert.
const TOKEN = 'ws-sekrit-token';

let server: http.Server | null = null;

async function startWs(token: string | undefined): Promise<number> {
  server = http.createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  setupWs(server, { subscribe() {}, unsubscribe() {}, token });
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  return (server!.address() as AddressInfo).port;
}

function basicHeader(password: string, username = 'dispatcher'): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

interface UpgradeResult {
  upgraded: boolean;
  status: number;
}

function attemptUpgrade(
  port: number,
  requestPath: string,
  headers: Record<string, string> = {},
): Promise<UpgradeResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13',
        ...headers,
      },
    });
    let settled = false;
    const settle = (result: UpgradeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      settle({ upgraded: true, status: 101 });
    });
    req.on('response', (res) => {
      // The rejected handshake is a normal HTTP 401 response with a short body.
      res.resume();
      res.once('end', () => settle({ upgraded: false, status: res.statusCode ?? 0 }));
    });
    req.on('error', reject);
    req.end();
  });
}

afterEach(() => {
  if (server) {
    server.close();
    server = null;
  }
});

describe('ws upgrade gate', () => {
  it('rejects an upgrade with no credentials (401, socket closed)', async () => {
    const port = await startWs(TOKEN);
    const result = await attemptUpgrade(port, '/api/ws');
    expect(result.upgraded).toBe(false);
    expect(result.status).toBe(401);
  });

  it('rejects a wrong query token', async () => {
    const port = await startWs(TOKEN);
    const result = await attemptUpgrade(port, '/api/ws?token=nope');
    expect(result.upgraded).toBe(false);
    expect(result.status).toBe(401);
  });

  it('completes the handshake with a ?token= query parameter', async () => {
    const port = await startWs(TOKEN);
    const result = await attemptUpgrade(port, `/api/ws?token=${encodeURIComponent(TOKEN)}`);
    expect(result.upgraded).toBe(true);
  });

  it('completes the handshake with a basic auth header (any username)', async () => {
    const port = await startWs(TOKEN);
    const result = await attemptUpgrade(port, '/api/ws', {
      Authorization: basicHeader(TOKEN, 'anyone'),
    });
    expect(result.upgraded).toBe(true);
  });

  it('completes the handshake with the x-dispatch-token header', async () => {
    const port = await startWs(TOKEN);
    const result = await attemptUpgrade(port, '/api/ws', { 'x-dispatch-token': TOKEN });
    expect(result.upgraded).toBe(true);
  });

  it('leaves the handshake open when no token is configured', async () => {
    const port = await startWs(undefined);
    const result = await attemptUpgrade(port, '/api/ws');
    expect(result.upgraded).toBe(true);
  });
});
