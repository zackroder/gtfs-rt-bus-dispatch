import type { IncomingBus } from '../../../shared/types';
import { Countdown } from './Countdown';
import { formatDelay } from '../format';

export function BusCard({ bus, generatedAt }: { bus: IncomingBus; generatedAt: number }) {
  const tone = bus.delaySeconds > 60 ? 'late' : bus.delaySeconds < -60 ? 'early' : '';
  return (
    <div className="card bus-card">
      <div className="card-main">
        <span className="route">{bus.routeShortName}</span>
        <span className="run">{bus.tripId}</span>
        {bus.vehicleId && <span className="vehicle">#{bus.vehicleId}</span>}
      </div>
      <div className="card-side">
        <Countdown seconds={bus.etaSeconds} generatedAt={generatedAt} />
        <span className={`delay ${tone}`}>{formatDelay(bus.delaySeconds)}</span>
      </div>
    </div>
  );
}
