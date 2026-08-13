import type { RouteState } from '../../../shared/types';
import { BusCard } from './BusCard';
import { LayoverCard } from './LayoverCard';
import { InterventionCard } from './InterventionCard';

export function RouteGroup({ route, generatedAt }: { route: RouteState; generatedAt: number }) {
  const empty = route.incoming.length === 0 && route.layovers.length === 0 && route.interventions.length === 0;
  return (
    <section className="route-group">
      <h2>Route {route.routeShortName}</h2>
      {route.incoming.length > 0 && (
        <div className="group">
          <h3>Incoming</h3>
          {route.incoming.map((bus) => (
            <BusCard key={`${bus.tripId}-${bus.vehicleId ?? ''}`} bus={bus} generatedAt={generatedAt} />
          ))}
        </div>
      )}
      {route.layovers.length > 0 && (
        <div className="group">
          <h3>Laying over</h3>
          {route.layovers.map((bus) => (
            <LayoverCard key={`${bus.tripId}-${bus.vehicleId ?? ''}`} bus={bus} generatedAt={generatedAt} />
          ))}
        </div>
      )}
      {route.interventions.length > 0 && (
        <div className="group">
          <h3>Interventions</h3>
          {route.interventions.map((intervention) => (
            <InterventionCard key={intervention.id} intervention={intervention} />
          ))}
        </div>
      )}
      {empty && <p className="empty">No activity in the lookahead window.</p>}
    </section>
  );
}
