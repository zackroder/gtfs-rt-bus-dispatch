import type { AppConfig, Intervention } from '../../../shared/types';
import type { OutboundDeparture } from './headway';

export interface InterventionContext {
  terminalId: string;
  routeId: string;
  nowSvc: number;
  generatedAt: number;
  rules: Pick<
    AppConfig,
    'gapFactor' | 'bunchFactor' | 'holdFraction' | 'maxHoldMinutes' | 'leadTimeMinutes' | 'minRestMinutes'
  >;
}

export interface InterventionResult {
  departures: OutboundDeparture[];
  interventions: Intervention[];
}

function isHoldable(state: string): boolean {
  return state === 'layover' || state === 'unknown';
}

function formatMinutes(seconds: number): string {
  const mins = Math.round(seconds / 60);
  return `${mins} min`;
}

export function computeInterventions(
  departures: OutboundDeparture[],
  ctx: InterventionContext,
): InterventionResult {
  const interventions: Intervention[] = [];
  const maxHold = ctx.rules.maxHoldMinutes * 60;
  const leadWindow = ctx.rules.leadTimeMinutes * 60;
  const minRest = ctx.rules.minRestMinutes * 60;

  for (let i = 0; i + 1 < departures.length; i++) {
    const leader = departures[i]!;
    const follower = departures[i + 1]!;
    const scheduledHeadway = follower.scheduledDeparture - leader.scheduledDeparture;
    if (scheduledHeadway <= 0) continue;

    const predictedHeadway = follower.predictedDeparture - leader.predictedDeparture;
    const gapThreshold = ctx.rules.gapFactor * scheduledHeadway;
    const bunchThreshold = ctx.rules.bunchFactor * scheduledHeadway;
    const leaderHoldable =
      isHoldable(leader.state) && leader.predictedDeparture > ctx.nowSvc;

    if (predictedHeadway > gapThreshold) {
      if (leaderHoldable && ctx.nowSvc >= leader.scheduledDeparture - leadWindow) {
        const holdSeconds = Math.min(
          ctx.rules.holdFraction * (predictedHeadway - scheduledHeadway),
          maxHold,
        );
        const until = leader.scheduledDeparture + holdSeconds;
        const reason =
          `Follower is late by ${formatMinutes(predictedHeadway - scheduledHeadway)}; ` +
          `hold the leader ${formatMinutes(holdSeconds)} to split the gap`;
        leader.hold = { holdSeconds, effectiveDeparture: until, rule: 'leader', reason };
        interventions.push({
          id: `hold_leader:${ctx.terminalId}:${leader.tripId}:${follower.tripId}`,
          terminalId: ctx.terminalId,
          routeId: ctx.routeId,
          rule: 'hold_leader',
          vehicleId: leader.vehicleId,
          leaderVehicleId: leader.vehicleId,
          followerVehicleId: follower.vehicleId,
          holdSeconds,
          until,
          reason,
          generatedAt: ctx.generatedAt,
        });
      } else if (!leaderHoldable) {
        interventions.push({
          id: `gap_alert:${ctx.terminalId}:${leader.tripId}:${follower.tripId}`,
          terminalId: ctx.terminalId,
          routeId: ctx.routeId,
          rule: 'gap_alert',
          leaderVehicleId: leader.vehicleId,
          followerVehicleId: follower.vehicleId,
          holdSeconds: 0,
          reason:
            `Predicted headway ${formatMinutes(predictedHeadway)} exceeds ` +
            `${ctx.rules.gapFactor}x scheduled (${formatMinutes(scheduledHeadway)}) and the ` +
            `leader has already departed`,
          generatedAt: ctx.generatedAt,
        });
      }
    } else if (predictedHeadway < bunchThreshold) {
      const holdSeconds = Math.min(bunchThreshold - predictedHeadway, maxHold);
      const until = follower.scheduledDeparture + holdSeconds;
      const reason =
        `Follower is early by ${formatMinutes(bunchThreshold - predictedHeadway)}; ` +
        `hold the follower ${formatMinutes(holdSeconds)} to prevent bunching`;
      if (isHoldable(follower.state)) {
        follower.hold = { holdSeconds, effectiveDeparture: until, rule: 'follower', reason };
      }
      interventions.push({
        id: `hold_follower:${ctx.terminalId}:${leader.tripId}:${follower.tripId}`,
        terminalId: ctx.terminalId,
        routeId: ctx.routeId,
        rule: 'hold_follower',
        vehicleId: follower.vehicleId,
        leaderVehicleId: leader.vehicleId,
        followerVehicleId: follower.vehicleId,
        holdSeconds,
        until,
        reason,
        generatedAt: ctx.generatedAt,
      });
    }
  }

  for (const departure of departures) {
    if (!isHoldable(departure.state) || !departure.hasArrivalInfo) continue;
    const predictedLayover = departure.scheduledDeparture - departure.predictedArrival;
    if (predictedLayover < minRest) {
      departure.minRest = true;
      interventions.push({
        id: `min_rest:${ctx.terminalId}:${departure.tripId}`,
        terminalId: ctx.terminalId,
        routeId: ctx.routeId,
        rule: 'min_rest',
        vehicleId: departure.vehicleId,
        holdSeconds: 0,
        reason:
          `Predicted layover of ${formatMinutes(predictedLayover)} is below the ` +
          `${ctx.rules.minRestMinutes} min minimum rest`,
        generatedAt: ctx.generatedAt,
      });
    }
  }

  return { departures, interventions };
}
