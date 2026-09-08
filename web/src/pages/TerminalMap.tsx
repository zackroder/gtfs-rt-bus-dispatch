/** Read-only debug map for one terminal: arrival/movement/departure buffer circles plus
 * color-coded, labeled arrows for live vehicles, rendered with raw Leaflet in a React wrapper. */
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { getTerminalMap, getTerminals, type TerminalsResponse } from '../api';
import { useStream } from '../hooks/useStream';
import { MapLegend } from '../components/MapLegend';
import { arrowDivIcon } from '../components/VehicleArrow';
import type { VehicleMapStatus } from '../../../shared/types';

// Status colors are shared by the arrow markers and the legend so a status stays recognizable.
const STATUS_COLORS: Record<VehicleMapStatus, string> = {
  inbound: '#3b82f6',
  arriving: '#f59e0b',
  laying_over: '#22c55e',
  departing: '#ea580c',
  departed: '#6b7280',
};

const POLL_MS = 10_000;

export default function TerminalMap() {
  const { id } = useParams<{ id: string }>();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  // The view is fitted to all geometry only on the first draw; later location updates re-render
  // markers/circles in place so the operator's zoom and pan are preserved across polls.
  const hasFitRef = useRef(false);
  const [terminals, setTerminals] = useState<TerminalsResponse | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState('');
  // Hold an active live stream on this terminal. The map endpoint joins the cached snapshot to
  // the raw VP feed server-side, and the snapshot cache is only populated while a client keeps the
  // terminal subscribed — so the map must stay subscribed or it would render an empty skeleton.
  useStream(id ?? '');

  // Create the Leaflet map once and keep it alive across data refreshes.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { attributionControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap contributors',
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, []);

  // Resolve the friendly terminal name, mirroring the terminal view page.
  useEffect(() => {
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

  // Poll the map endpoint and redraw its layers, stopping cleanly when the page unmounts.
  useEffect(() => {
    if (!id) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const data = await getTerminalMap(id);
        if (disposed) return;
        setMapError(null);
        setUpdatedAt(new Date(data.generatedAt * 1000).toLocaleTimeString());
        drawMap(data);
      } catch (err) {
        if (!disposed) setMapError(err instanceof Error ? err.message : String(err));
      }
    };
    const tick = () => {
      timer = setTimeout(() => {
        void load();
        tick();
      }, POLL_MS);
    };
    void load();
    tick();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  function drawMap(data: import('../../../shared/types').TerminalMapSnapshot) {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    const bounds: L.LatLngBounds = L.latLngBounds([]);

    // Draw the geofence circles in a fixed order so the arrival ring (smallest) stays on top.
    // Stop-status is the primary arrival/departure signal, so these buffers are the geometry-only
    // fallback geofence: drawn de-emphasized (dashed, lighter fill) and labeled "fallback".
    const kindOrder = ['departure', 'movement', 'arrival'] as const;
    const kindColor = { arrival: '#f59e0b', movement: '#3b82f6', departure: '#ea580c' } as const;
    for (const kind of kindOrder) {
      for (const buffer of data.buffers.filter((b) => b.kind === kind)) {
        L.circle([buffer.lat, buffer.lon], {
          radius: buffer.radiusMeters,
          color: kindColor[kind],
          weight: 1,
          dashArray: buffer.fallback === true ? '4 4' : undefined,
          fillOpacity: kind === 'arrival' ? 0.1 : 0.04,
        })
          .bindTooltip(`${buffer.fallback === true ? 'fallback ' : ''}${kind} · ${buffer.radiusMeters}m · ${buffer.stopId}`)
          .addTo(layer);
        bounds.extend([buffer.lat, buffer.lon]);
      }
    }

    // Render vehicle arrows last so they sit above the circles. The tooltip now shows the feed's
    // own reported stop + status alongside the derived classification.
    for (const marker of data.vehicles) {
      const color = STATUS_COLORS[marker.status];
      const reported = marker.currentStatus
        ? ` · ${marker.currentStatus}${marker.currentStopName ? ` @ ${marker.currentStopName}` : ''}`
        : '';
      L.marker([marker.lat, marker.lon], {
        icon: arrowDivIcon({ fill: color, headingDegrees: marker.headingDegrees ?? 0, label: marker.label }),
      })
        .bindTooltip(`${marker.label} · ${marker.status}${reported}`)
        .addTo(layer);
      bounds.extend([marker.lat, marker.lon]);
    }

    // Fit to all geometry only on the first draw so the initial view shows every circle and
    // vehicle. Subsequent updates leave the operator's zoom/pan untouched.
    if (!hasFitRef.current) {
      if (data.center.lat !== 0 || data.center.lon !== 0) {
        bounds.extend([data.center.lat, data.center.lon]);
      }
      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 17 });
      } else if (data.center.lat !== 0 || data.center.lon !== 0) {
        map.setView([data.center.lat, data.center.lon], 15);
      }
      hasFitRef.current = true;
    }
  }

  const terminal = terminals?.terminals.find((t) => t.id === id);

  return (
    <div className="terminal-map-page">
      <header className="page-header">
        <Link to={`/terminal/${id ?? ''}`}>← Terminal view</Link>
        <span className="updated">updated {updatedAt}</span>
      </header>
      <h1>{terminal?.name ?? id} · map</h1>
      <MapLegend />
      <div className="map-note">
        Circles are the <strong>fallback</strong> geofence (used only when the feed omits
        stop-status); vehicle markers show the feed's reported stop + status in their tooltips.
      </div>
      {terminalError && <div className="error">{terminalError}</div>}
      {mapError && <div className="error">{mapError}</div>}
      <div ref={containerRef} className="map-container" />
    </div>
  );
}
