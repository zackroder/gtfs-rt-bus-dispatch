/** Terminal index page grouped by route for quick dispatch-area selection. */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getTerminals, type TerminalsResponse } from '../api';
import { RouteBadge } from '../components/RouteBadge';

export default function Terminals() {
  const [data, setData] = useState<TerminalsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Ignore a response after navigation so an old request cannot overwrite this page.
    let disposed = false;
    getTerminals()
      .then((response) => {
        if (!disposed) setData(response);
      })
      .catch((err: unknown) => {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      disposed = true;
    };
  }, []);

  if (error) return <div className="error">{error}</div>;
  if (!data) return <div className="loading">Loading terminals…</div>;
  if (data.terminals.length === 0) {
    // Static GTFS must be loaded before the server can discover configured routes.
    return (
      <div className="terminals-page">
        <h1>Terminals</h1>
        <p className="empty">No terminals discovered yet. Load GTFS static data and check back.</p>
        <Link className="config-link" to="/config">
          Settings
        </Link>
      </div>
    );
  }

  return (
    <div className="terminals-page">
      <h1>Terminals</h1>
      {/* Route grouping follows the server's normalized route index. */}
      {data.routes.map((route) => (
        <div key={route.routeId} className="route-group">
          <h2>
            <RouteBadge
              shortName={route.shortName || route.routeId}
              color={route.color}
              textColor={route.textColor}
            />
            {route.longName && <span className="route-name">{route.longName}</span>}
          </h2>
          {route.terminalIds.map((terminalId) => {
            // A stale route index entry should not produce a broken link.
            const terminal = data.terminals.find((t) => t.id === terminalId);
            if (!terminal) return null;
            return (
              <Link key={terminalId} className="terminal-link" to={`/terminal/${terminalId}`}>
                {terminal.name} <small>{terminal.id}</small>
              </Link>
            );
          })}
        </div>
      ))}
      <Link className="config-link" to="/config">
        Settings
      </Link>
    </div>
  );
}
