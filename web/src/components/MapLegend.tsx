/** Color key for the debug terminal map, matching the server's status color mapping. */
import type { VehicleMapStatus } from '../../../shared/types';

// Status colors are documented in the shared map contract and mirrored here for the legend.
const STATUS_COLORS: Record<VehicleMapStatus, string> = {
  inbound: '#3b82f6',
  arriving: '#f59e0b',
  laying_over: '#22c55e',
  departing: '#ea580c',
  departed: '#6b7280',
};

const ORDER: VehicleMapStatus[] = ['inbound', 'arriving', 'laying_over', 'departing', 'departed'];

const LABELS: Record<VehicleMapStatus, string> = {
  inbound: 'Inbound',
  arriving: 'Arriving',
  laying_over: 'Laying over',
  departing: 'Departing',
  departed: 'Departed',
};

export function MapLegend() {
  return (
    <div className="map-legend">
      {ORDER.map((status) => (
        <span key={status} className="map-legend-item">
          <span
            className="map-legend-swatch"
            style={{ backgroundColor: STATUS_COLORS[status] }}
          />
          {LABELS[status]}
        </span>
      ))}
    </div>
  );
}
