/**
 * Live terminal snapshot hook with websocket-first delivery and polling fallback.
 *
 * Websocket messages are validated against the shared envelope schema; polling keeps
 * the page useful during connection failures and is stopped whenever a socket opens.
 */
import { useEffect, useRef, useState } from 'react';
import { wsSnapshotMessageSchema, type TerminalSnapshot } from '../../../shared/types';
import { getTerminal } from '../api';

export type StreamSource = 'websocket' | 'polling' | 'idle';

export interface StreamState {
  snapshot: TerminalSnapshot | null;
  source: StreamSource;
  error: string | null;
}

export function useStream(terminalId: string, route?: string): StreamState {
  const [snapshot, setSnapshot] = useState<TerminalSnapshot | null>(null);
  const [source, setSource] = useState<StreamSource>('idle');
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pollRef = useRef<number | undefined>(undefined);
  const reconnectRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    // The disposed flag prevents late fetch/socket callbacks from repopulating a
    // page after its terminal or route has changed.
    let disposed = false;
    setSnapshot(null);
    setSource('idle');
    setError(null);

    const filterRoute = (snap: TerminalSnapshot): TerminalSnapshot =>
      // The server may broadcast all terminals/routes; the hook exposes only the
      // selected terminal and optional route to its page.
      route ? { ...snap, routes: snap.routes.filter((r) => r.routeId === route) } : snap;

    const poll = async () => {
      try {
        const snap = await getTerminal(terminalId, route);
        if (disposed) return;
        setSnapshot(snap);
        setSource('polling');
        setError(null);
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      }
    };

    const startPolling = () => {
      // The immediate request avoids waiting ten seconds before fallback data appears.
      if (disposed || pollRef.current !== undefined) return;
      void poll();
      pollRef.current = window.setInterval(() => void poll(), 10000);
    };

    const stopPolling = () => {
      if (pollRef.current !== undefined) {
        window.clearInterval(pollRef.current);
        pollRef.current = undefined;
      }
    };

    const onWsMessage = (event: MessageEvent) => {
      try {
        // JSON parsing and schema validation protect rendering from arbitrary socket data.
        const parsed = wsSnapshotMessageSchema.safeParse(JSON.parse(String(event.data)));
        if (!parsed.success) throw new Error('invalid live data');
        const msg = parsed.data;
        const snap = msg.snapshots.find((item) => item.terminalId === terminalId);
        if (!snap || disposed) return;
        setSnapshot(filterRoute(snap));
        setSource('websocket');
        setError(null);
      } catch {
        if (!disposed) setError('Received invalid live data');
      }
    };

    const connectWs = () => {
      if (disposed) return;
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${protocol}://${window.location.host}/api/ws`);
      wsRef.current = ws;
      ws.onopen = () => {
        if (disposed) return;
        stopPolling();
        setSource('websocket');
        // Subscription narrows the server broadcast to this page's terminal.
        ws.send(JSON.stringify({ type: 'subscribe', terminalId }));
      };
      ws.onmessage = onWsMessage;
      ws.onclose = () => {
        wsRef.current = null;
        if (disposed) return;
        startPolling();
        setSource('polling');
        // One delayed reconnect prevents a close/error loop from opening sockets rapidly.
        if (reconnectRef.current === undefined) {
          reconnectRef.current = window.setTimeout(() => {
            reconnectRef.current = undefined;
            connectWs();
          }, 5000);
        }
      };
      ws.onerror = () => ws.close();
    };

    void poll();
    // Start both paths: polling supplies an immediate baseline while the socket connects.
    connectWs();
    return () => {
      disposed = true;
      wsRef.current?.close();
      wsRef.current = null;
      stopPolling();
      if (reconnectRef.current !== undefined) {
        window.clearTimeout(reconnectRef.current);
        reconnectRef.current = undefined;
      }
    };
  }, [terminalId, route]);

  return { snapshot, source, error };
}
