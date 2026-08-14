import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { TerminalSnapshot } from '../../../shared/types';

export interface WsDeps {
  getSnapshots(): TerminalSnapshot[];
  subscribe(terminalId: string): void;
  unsubscribe(terminalId: string): void;
}

export interface WsBroadcaster {
  broadcast(snapshots: TerminalSnapshot[]): void;
}

export function setupWs(httpServer: Server, deps: WsDeps): WsBroadcaster {
  const wss = new WebSocketServer({ server: httpServer, path: '/api/ws' });
  wss.on('connection', (socket) => {
    let terminalId: string | null = null;
    socket.send(JSON.stringify({ type: 'snapshots', snapshots: deps.getSnapshots() }));
    socket.on('message', (data) => {
      try {
        const msg = JSON.parse(String(data)) as { type?: string; terminalId?: string };
        if (msg.type === 'subscribe' && typeof msg.terminalId === 'string') {
          terminalId = msg.terminalId;
          deps.subscribe(msg.terminalId);
        } else if (msg.type === 'unsubscribe' && typeof msg.terminalId === 'string') {
          deps.unsubscribe(msg.terminalId);
          if (terminalId === msg.terminalId) terminalId = null;
        }
      } catch {
        // ignore malformed frames
      }
    });
    socket.on('close', () => {
      if (terminalId) deps.unsubscribe(terminalId);
    });
  });
  return {
    broadcast(snapshots) {
      const message = JSON.stringify({ type: 'snapshots', snapshots });
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      }
    },
  };
}
