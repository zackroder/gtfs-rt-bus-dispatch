/** Renders one route's operational groups in the order useful to a dispatcher. */
import type { RouteState } from '../../../shared/types';
import { BusCard } from './BusCard';
import { LayoverCard } from './LayoverCard';
import { DepartedCard } from './DepartedCard';
import { InterventionCard } from './InterventionCard';
import { RouteBadge } from './RouteBadge';

export function RouteGroup({
  route,
  generatedAt,
  serviceDayStartSeconds,
}: {
  route: RouteState;
  generatedAt: number;
  serviceDayStartSeconds: number;
}) {
  // Empty is computed across all groups because an intervention is activity even
  // when no vehicle currently occupies the lookahead lists.
  const empty =
    route.incoming.length === 0 &&
    route.layovers.length === 0 &&
    route.departed.length === 0 &&
    route.interventions.length === 0;
  return (
    <section className="route-group">
      <h2>
        <RouteBadge
          shortName={route.routeShortName}
          color={route.color}
          textColor={route.textColor}
        />
        {route.routeLongName && <span className="route-name">{route.routeLongName}</span>}
      </h2>
      {route.layovers.length > 0 && (
        <div className="group">
          {/* Layovers come first because they are the immediate dispatch decision set. */}
          <h3>Laying over</h3>
          {route.layovers.map((bus) => (
            <LayoverCard
              key={`${bus.tripId}-${bus.vehicleId ?? ''}`}
              bus={bus}
              generatedAt={generatedAt}
              serviceDayStartSeconds={serviceDayStartSeconds}
            />
          ))}
        </div>
      )}
      {route.interventions.length > 0 && (
        <div className="group">
          <h3>Interventions</h3>
          {route.interventions.map((intervention) => (
            <InterventionCard
              key={intervention.id}
              intervention={intervention}
              serviceDayStartSeconds={serviceDayStartSeconds}
            />
          ))}
        </div>
      )}
      {route.incoming.length > 0 && (
        <div className="group">
          <h3>Inbound vehicles</h3>
          {route.incoming.map((bus) => (
            <BusCard
              key={`${bus.tripId}-${bus.vehicleId ?? ''}`}
              bus={bus}
              routeColor={route.color}
              routeTextColor={route.textColor}
              serviceDayStartSeconds={serviceDayStartSeconds}
            />
          ))}
        </div>
      )}
      {route.departed.length > 0 && (
        <div className="group">
          <h3>Recently departed</h3>
          {route.departed.map((bus) => (
            <DepartedCard
              key={`${bus.tripId}-${bus.vehicleId ?? ''}`}
              bus={bus}
              serviceDayStartSeconds={serviceDayStartSeconds}
            />
          ))}
        </div>
      )}
      {empty && <p className="empty">No activity in the lookahead window.</p>}
    </section>
  );
}
