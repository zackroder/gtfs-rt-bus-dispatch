import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { TerminalSnapshot } from '../../../shared/types';

export interface WsDeps {
  getSnapshots(): TerminalSnapshot[];
}

export interface WsBroadcaster {
  broadcast(snapshots: TerminalSnapshot[]): void;
}

export function setupWs(httpServer: Server, deps: WsDeps): WsBroadcaster {
  const wss = new WebSocketServer({ server: httpServer, path: '/api/ws' });
  wss.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'snapshots', snapshots: deps.getSnapshots() }));
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
