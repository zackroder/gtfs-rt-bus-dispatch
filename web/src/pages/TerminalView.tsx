/** Live terminal dashboard combining stream status with route-level vehicle cards. */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getTerminals, type TerminalsResponse } from '../api';
import { useStream } from '../hooks/useStream';
import { RouteGroup } from '../components/RouteGroup';
import { VehicleDetailPanel } from '../components/VehicleDetailPanel';

export default function TerminalView() {
  const { id } = useParams<{ id: string }>();
  const [terminals, setTerminals] = useState<TerminalsResponse | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const { snapshot, source, error } = useStream(id ?? '');
  // Selecting a card opens its detail as a bottom-sheet overlay; selecting another card moves
  // the panel, and the close button (or backdrop) clears the selection.
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);

  useEffect(() => {
    // The terminal index supplies the friendly name while the stream supplies live data.
    let disposed = false;
    setTerminalError(null);
    setSelectedTripId(null);
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

  const toggleSelection = (tripId: string) => {
    // Clicking the selected card again closes the panel; clicking another card moves it.
    setSelectedTripId((current) => (current === tripId ? null : tripId));
  };

  return (
    <div className="terminal-page">
      <header className="page-header">
        <Link to="/">← Terminals</Link>
        {/* The source label exposes websocket/polling fallback state to operators. */}
        <span className={`source source-${source}`}>{source}</span>
        <span className="updated">updated {updatedAt}</span>
      </header>
      <h1>{terminal?.name ?? id}</h1>
      <Link className="map-link" to={`/terminal/${id ?? ''}/map`}>
        View debug map
      </Link>
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
              selectedTripId={selectedTripId}
              onSelect={toggleSelection}
            />
          ))
        ) : (
          <p className="empty">No activity at this terminal right now.</p>
        )
      ) : (
        <div className="loading">Waiting for live data…</div>
      )}
      {/* The detail panel floats above the route list as a bottom sheet so it stays prominent
          while the operator keeps the list under it. */}
      {selectedTripId && (
        <VehicleDetailPanel
          key={selectedTripId}
          terminalId={id ?? ''}
          tripId={selectedTripId}
          // The stream snapshot is present whenever a card could have been selected.
          serviceDayStartSeconds={snapshot?.serviceDayStartSeconds ?? 0}
          onClose={() => setSelectedTripId(null)}
        />
      )}
    </div>
  );
}
