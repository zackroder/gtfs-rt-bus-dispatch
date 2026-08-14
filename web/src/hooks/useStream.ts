import { useEffect, useRef, useState } from 'react';
import type { TerminalSnapshot } from '../../../shared/types';
import { getTerminal } from '../api';

export type StreamSource = 'websocket' | 'polling' | 'idle';

export interface StreamState {
  snapshot: TerminalSnapshot | null;
  source: StreamSource;
  error: string | null;
}

interface WsMessage {
  type: string;
  snapshots?: TerminalSnapshot[];
}

export function useStream(terminalId: string, route?: string): StreamState {
  const [snapshot, setSnapshot] = useState<TerminalSnapshot | null>(null);
  const [source, setSource] = useState<StreamSource>('idle');
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pollRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    const accept = (snap: TerminalSnapshot | null) => {
      if (!disposed) setSnapshot(snap);
    };

    const filterRoute = (snap: TerminalSnapshot): TerminalSnapshot =>
      route ? { ...snap, routes: snap.routes.filter((r) => r.routeId === route) } : snap;

    const poll = async () => {
      try {
        const snap = await getTerminal(terminalId, route);
        accept(snap);
        setSource('polling');
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      }
    };

    const onWsMessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(String(event.data)) as WsMessage;
        if (msg.type !== 'snapshots' || !msg.snapshots) return;
        const snap = msg.snapshots.find((s) => s.terminalId === terminalId);
        if (snap) {
          accept(filterRoute(snap));
          setSource('websocket');
        }
      } catch {
        // ignore malformed frames
      }
    };

    const connectWs = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${protocol}://${window.location.host}/api/ws`);
      wsRef.current = ws;
      ws.onopen = () => {
        setSource('websocket');
        ws.send(JSON.stringify({ type: 'subscribe', terminalId }));
      };
      ws.onmessage = onWsMessage;
      ws.onclose = () => {
        wsRef.current = null;
        if (disposed) return;
        setSource('polling');
        if (pollRef.current === undefined) {
          pollRef.current = window.setInterval(() => {
            void poll();
          }, 10000);
        }
      };
      ws.onerror = () => ws.close();
    };

    connectWs();
    return () => {
      disposed = true;
      wsRef.current?.close();
      if (pollRef.current !== undefined) {
        window.clearInterval(pollRef.current);
        pollRef.current = undefined;
      }
    };
  }, [terminalId, route]);

  return { snapshot, source, error };
}
