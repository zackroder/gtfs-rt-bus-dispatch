/** Live terminal dashboard combining stream status with route-level vehicle cards. */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getTerminals, type TerminalsResponse } from '../api';
import { useStream } from '../hooks/useStream';
import { RouteGroup } from '../components/RouteGroup';

export default function TerminalView() {
  const { id } = useParams<{ id: string }>();
  const [terminals, setTerminals] = useState<TerminalsResponse | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const { snapshot, source, error } = useStream(id ?? '');

  useEffect(() => {
    // The terminal index supplies the friendly name while the stream supplies live data.
    let disposed = false;
    setTerminalError(null);
    getTerminals()
      .then((response) => {
        if (!disposed) setTerminals(response);
      })
      .catch((err: unknown) => {
        if (!disposed) setTerminalError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      disposed = true;
    };
  }, [id]);

  const terminal = terminals?.terminals.find((t) => t.id === id);
  // Server timestamps are epoch seconds; Date expects milliseconds for local display.
  const updatedAt = snapshot ? new Date(snapshot.generatedAt * 1000).toLocaleTimeString() : '';

  return (
    <div className="terminal-page">
      <header className="page-header">
        <Link to="/">← Terminals</Link>
        {/* The source label exposes websocket/polling fallback state to operators. */}
        <span className={`source source-${source}`}>{source}</span>
        <span className="updated">updated {updatedAt}</span>
      </header>
      <h1>{terminal?.name ?? id}</h1>
      {terminalError && <div className="error">{terminalError}</div>}
      {!terminalError && terminals && !terminal && <div className="error">Unknown terminal.</div>}
      {error && <div className="error">{error}</div>}
      {snapshot ? (
        snapshot.routes.length > 0 ? (
          // Route groups own the vehicle/intervention ordering and empty-state details.
          snapshot.routes.map((route) => (
            <RouteGroup
              key={route.routeId}
              route={route}
              generatedAt={snapshot.generatedAt}
              serviceDayStartSeconds={snapshot.serviceDayStartSeconds}
            />
          ))
        ) : (
          <p className="empty">No activity at this terminal right now.</p>
        )
      ) : (
        <div className="loading">Waiting for live data…</div>
      )}
    </div>
  );
}
