/**
 * Detail panel for a selected vehicle card: mini Leaflet map with live arrow + stop dots, the
 * upcoming-stops list, and the block strip. Polls the detail endpoint every 10s (matching the
 * terminal map cadence) and fetches the block strip once per selection unless the block changes.
 */
import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { getBlockTimeline, getConfig, getVehicleDetail } from '../api';
import { RouteBadge } from './RouteBadge';
import { arrowDivIcon } from './VehicleArrow';
import { BlockStrip } from './BlockStrip';
import { formatClock, formatHold } from '../format';
import type { BlockTimeline, VehicleDetail } from '../../../shared/types';

const POLL_MS = 10_000;

const STATUS_LABEL: Record<VehicleDetail['status'], string> = {
  incoming: 'incoming',
  layover: 'laying over',
  departed: 'departed',
};

export function VehicleDetailPanel({
  terminalId,
  tripId,
  serviceDayStartSeconds,
  onClose,
}: {
  terminalId: string;
  tripId: string;
  serviceDayStartSeconds: number;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const hasFitRef = useRef(false);
  const [detail, setDetail] = useState<VehicleDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [timeline, setTimeline] = useState<BlockTimeline | null>(null);
  const [timelineBlockId, setTimelineBlockId] = useState<string | null>(null);
  const [maxAgeSeconds, setMaxAgeSeconds] = useState(300);

  const staleMinutes = detail?.position && detail.position.ageSeconds > maxAgeSeconds
    ? Math.round(detail.position.ageSeconds / 60)
    : null;

  // The stale-marker threshold is the same config value the engine uses for freshness.
  useEffect(() => {
    let disposed = false;
    getConfig()
      .then((config) => {
        if (!disposed) setMaxAgeSeconds(config.vehiclePositionMaxAgeSeconds ?? 300);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, []);

  // Create the mini map once and keep it alive across polls.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { attributionControl: false });
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

  // Poll the detail endpoint while the panel is open; a 404 is the "no live data" empty state.
  useEffect(() => {
    if (!terminalId || !tripId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const data = await getVehicleDetail(terminalId, tripId);
        if (disposed) return;
        setDetailError(null);
        if (data === null) {
          setMissing(true);
          setDetail(null);
        } else {
          setMissing(false);
          setDetail(data);
        }
      } catch (err) {
        if (disposed) return;
        setDetailError(err instanceof Error ? err.message : String(err));
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
  }, [terminalId, tripId]);

  // Fetch the strip once per selection; refetch only when the card's block changes.
  useEffect(() => {
    const blockId = detail?.blockId;
    if (!blockId) {
      setTimeline(null);
      setTimelineBlockId(null);
      return;
    }
    if (blockId === timelineBlockId) return;
    let disposed = false;
    getBlockTimeline(blockId)
      .then((data) => {
        if (disposed) return;
        setTimelineBlockId(blockId);
        setTimeline(data);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [detail?.blockId]);

  // Redraw the mini-map layers whenever the detail changes.
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    if (!detail) return;
    const bounds: L.LatLngBounds = L.latLngBounds([]);

    if (detail.terminalStop && detail.terminalStop.lat !== undefined && detail.terminalStop.lon !== undefined) {
      L.circleMarker([detail.terminalStop.lat, detail.terminalStop.lon], {
        radius: 9,
        color: '#1c2330',
        fillColor: '#ffffff',
        fillOpacity: 0.6,
        weight: 2,
      })
        .bindTooltip(detail.terminalStop.stopName)
        .addTo(layer);
      bounds.extend([detail.terminalStop.lat, detail.terminalStop.lon]);
    }

    // Passed stops render hollow, upcoming stops filled, so the vehicle's progress reads at a glance.
    for (const stop of detail.passedStops ?? []) {
      if (stop.lat === undefined || stop.lon === undefined) continue;
      L.circleMarker([stop.lat, stop.lon], {
        radius: 5,
        color: '#6b7280',
        fillColor: '#ffffff',
        fillOpacity: 0,
        weight: 2,
      })
        .bindTooltip(stop.stopName)
        .addTo(layer);
      bounds.extend([stop.lat, stop.lon]);
    }
    const routeColor = detail.color ? `#${detail.color.replace('#', '')}` : '#2563eb';
    for (const stop of detail.upcomingStops) {
      if (stop.lat === undefined || stop.lon === undefined) continue;
      L.circleMarker([stop.lat, stop.lon], {
        radius: 6,
        color: routeColor,
        fillColor: routeColor,
        fillOpacity: 1,
        weight: 1.5,
      })
        .bindTooltip(
          `${stop.stopName}${stop.predicted !== undefined ? ` · est ${formatClock(stop.predicted, serviceDayStartSeconds)}` : ''}`,
        )
        .addTo(layer);
      bounds.extend([stop.lat, stop.lon]);
    }

    if (detail.position) {
      // A stale sample keeps its marker but greys out, matching the config's freshness threshold.
      const stale = detail.position.ageSeconds > maxAgeSeconds;
      L.marker([detail.position.lat, detail.position.lon], {
        icon: arrowDivIcon({
          fill: stale ? '#9ca3af' : routeColor,
          headingDegrees: detail.position.headingDegrees ?? 0,
        }),
      })
        .bindTooltip(
          `#${detail.vehicleId ?? '—'}${stale ? ` · last seen ${Math.round(detail.position.ageSeconds / 60)} min ago` : ''}`,
        )
        .addTo(layer);
      bounds.extend([detail.position.lat, detail.position.lon]);
    }

    if (!hasFitRef.current) {
      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
      } else {
        map.setView([0, 0], 2);
      }
      hasFitRef.current = true;
    }
  }, [detail, maxAgeSeconds, serviceDayStartSeconds]);

  return (
    <div className="vehicle-detail-panel" role="dialog" aria-label={`Run detail ${tripId}`}>
      {detailError && (
        <div className="vehicle-detail-state">
          <div className="error">{detailError}</div>
          <button onClick={onClose}>Close</button>
        </div>
      )}
      {!detailError && missing && (
        <div className="vehicle-detail-state">
          <p>No live data for this run.</p>
          <button onClick={onClose}>Close</button>
        </div>
      )}
      {!detailError && !missing && !detail && <div className="vehicle-detail-state loading">Loading run detail…</div>}
      {!detailError && !missing && detail && (
        <>
          <div className="vehicle-detail-header">
            <RouteBadge
              shortName={detail.routeShortName}
              color={detail.color}
              textColor={detail.textColor}
            />
            <div className="vehicle-detail-title">
              <strong>{detail.destination}</strong>
              <span className={`vehicle-detail-status status-${detail.status}`}>
                {STATUS_LABEL[detail.status]}
              </span>
            </div>
            {detail.hold && <span className="hold-badge">held {formatHold(detail.hold.holdSeconds)}</span>}
            {detail.overdueSeconds !== undefined && detail.overdueSeconds >= 60 && (
              <span className="badge overdue">overdue {Math.round(detail.overdueSeconds / 60)} min</span>
            )}
            {staleMinutes !== null && <span className="stale-note">last seen {staleMinutes} min ago</span>}
            <button className="vehicle-detail-close" onClick={onClose} aria-label="Close detail">
              ×
            </button>
          </div>

          <div ref={containerRef} className="vehicle-detail-map" />

          <div className="vehicle-detail-stops">
            <h4>Upcoming stops</h4>
            {detail.upcomingStops.length === 0 ? (
              <p className="empty">No upcoming stops in the feed window.</p>
            ) : (
              <ol>
                {detail.upcomingStops.map((stop) => (
                  <li key={`${stop.stopSequence}-${stop.stopId}`}>
                    <span className="stop-name">
                      {stop.source === 'predicted' && <span className="est-dot" aria-hidden="true" />}
                      {stop.stopName}
                    </span>
                    <span className="stop-time">
                      {stop.source === 'predicted' && stop.predicted !== undefined && <em>est </em>}
                      {formatClock(
                        stop.source === 'predicted' && stop.predicted !== undefined ? stop.predicted : stop.scheduled,
                        serviceDayStartSeconds,
                      )}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>

          {detail.blockId && (
            <div className="vehicle-detail-block">
              <div className="block-strip-header">
                <span className="block-strip-title">Block {detail.blockId}</span>
                <span className="strip-legend">
                  <span className="strip-legend-item">
                    <span className="strip-legend-swatch strip-legend-solid" aria-hidden="true" />
                    solid · dir 0
                  </span>
                  <span className="strip-legend-item">
                    <span className="strip-legend-swatch strip-legend-tinted" aria-hidden="true" />
                    tinted · dir 1
                  </span>
                </span>
              </div>
              {timeline ? (
                <BlockStrip timeline={timeline} serviceDayStartSeconds={serviceDayStartSeconds} />
              ) : (
                <p className="empty">No block data.</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}