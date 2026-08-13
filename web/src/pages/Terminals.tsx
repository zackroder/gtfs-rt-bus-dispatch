import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getTerminals, type TerminalsResponse } from '../api';

export default function Terminals() {
  const [data, setData] = useState<TerminalsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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
      {data.routes.map((route) => (
        <div key={route.routeId} className="route-group">
          <h2>Route {route.shortName || route.routeId}</h2>
          {route.terminalIds.map((terminalId) => {
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
