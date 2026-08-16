import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { TerminalSnapshot } from '../../../shared/types';

// The WS protocol is intentionally small: clients select one terminal and receive matching snapshots.
export interface WsDeps {
  subscribe(terminalId: string): void;
  unsubscribe(terminalId: string): void;
}

export interface WsBroadcaster {
  broadcast(snapshots: TerminalSnapshot[]): void;
}

// Attach the terminal subscription protocol and return a filtered snapshot broadcaster.
export function setupWs(httpServer: Server, deps: WsDeps): WsBroadcaster {
  const wss = new WebSocketServer({ server: httpServer, path: '/api/ws' });
  const clientSubscriptions = new Map<WebSocket, Set<string>>();
  const alive = new WeakMap<WebSocket, boolean>();
  const heartbeat = setInterval(() => {
    // A missed pong indicates a dead connection; terminating it releases its terminal subscription.
    for (const client of wss.clients) {
      if (alive.get(client) === false) {
        client.terminate();
        continue;
      }
      alive.set(client, false);
      client.ping();
    }
  }, 30000);
  wss.on('close', () => clearInterval(heartbeat));
  wss.on('connection', (socket) => {
    const terminalIds = new Set<string>();
    clientSubscriptions.set(socket, terminalIds);
    alive.set(socket, true);
    socket.on('pong', () => {
      alive.set(socket, true);
    });
    socket.send(JSON.stringify({ type: 'snapshots', snapshots: [] }));
    socket.on('message', (data) => {
      try {
        // Subscription messages are untrusted JSON and are handled without allowing malformed frames
        // to disrupt the connection or the server's subscription counts.
        const msg = JSON.parse(String(data)) as { type?: string; terminalId?: string };
        if (msg.type === 'subscribe' && typeof msg.terminalId === 'string') {
          if (terminalIds.has(msg.terminalId)) return;
          // A client has one active terminal view; replace its previous selection atomically.
          for (const current of terminalIds) {
            if (current !== msg.terminalId) deps.unsubscribe(current);
          }
          terminalIds.clear();
          terminalIds.add(msg.terminalId);
          deps.subscribe(msg.terminalId);
        } else if (msg.type === 'unsubscribe' && typeof msg.terminalId === 'string') {
          if (terminalIds.delete(msg.terminalId)) deps.unsubscribe(msg.terminalId);
        }
      } catch {
        // ignore malformed frames
      }
    });
    socket.on('close', () => {
      // Every subscription is balanced on close, including clients that disconnect unexpectedly.
      for (const terminalId of terminalIds) deps.unsubscribe(terminalId);
      clientSubscriptions.delete(socket);
    });
  });
  return {
    broadcast(snapshots) {
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          const subscribed = clientSubscriptions.get(client);
          const selected = subscribed
            ? snapshots.filter((snapshot) => subscribed.has(snapshot.terminalId))
            : [];
          // Do not send unrelated terminal data to a connected client.
          if (selected.length > 0) {
            client.send(JSON.stringify({ type: 'snapshots', snapshots: selected }));
          }
        }
      }
    },
  };
}
