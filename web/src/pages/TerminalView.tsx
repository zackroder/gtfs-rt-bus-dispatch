import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getTerminals, type TerminalsResponse } from '../api';
import { useStream } from '../hooks/useStream';
import { RouteGroup } from '../components/RouteGroup';

export default function TerminalView() {
  const { id } = useParams<{ id: string }>();
  const [terminals, setTerminals] = useState<TerminalsResponse | null>(null);
  const { snapshot, source, error } = useStream(id ?? '');

  useEffect(() => {
    let disposed = false;
    getTerminals()
      .then((response) => {
        if (!disposed) setTerminals(response);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, []);

  const terminal = terminals?.terminals.find((t) => t.id === id);
  const updatedAt = snapshot ? new Date(snapshot.generatedAt * 1000).toLocaleTimeString() : '';

  return (
    <div className="terminal-page">
      <header className="page-header">
        <Link to="/">← Terminals</Link>
        <span className={`source source-${source}`}>{source}</span>
        <span className="updated">updated {updatedAt}</span>
      </header>
      <h1>{terminal?.name ?? id}</h1>
      {error && <div className="error">{error}</div>}
      {snapshot ? (
        snapshot.routes.length > 0 ? (
          snapshot.routes.map((route) => (
            <RouteGroup key={route.routeId} route={route} generatedAt={snapshot.generatedAt} />
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
