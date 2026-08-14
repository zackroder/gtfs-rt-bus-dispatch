import type { HoldOverride } from '../../../shared/types';

export interface DispatchDeparture {
  tripId: string;
  vehicleId?: string;
  state: 'incoming' | 'layover' | 'departed';
  scheduledDeparture: number;
  terminalArrival?: number;
  edt: number;
  departedSeconds?: number;
  hold?: HoldOverride;
}

export function expectedDepartureTime(
  scheduledDeparture: number,
  terminalArrival: number | undefined,
  minRestSeconds: number,
): number {
  if (terminalArrival === undefined) return scheduledDeparture;
  return Math.max(scheduledDeparture, terminalArrival + minRestSeconds);
}

export function holdSeconds(
  backwardHeadway: number,
  forwardHeadway: number,
  maxHoldSeconds: number,
): number {
  return Math.min(Math.max((backwardHeadway - forwardHeadway) / 2, 0), maxHoldSeconds);
}

export function effectiveDeparture(departure: DispatchDeparture): number {
  if (departure.state === 'departed' && departure.departedSeconds !== undefined) {
    return departure.departedSeconds;
  }
  if (departure.hold) return departure.hold.effectiveDeparture;
  return departure.edt;
}

export interface TripletDecision {
  tripId: string;
  vehicleId?: string;
  leaderTripId: string;
  leaderVehicleId?: string;
  followerTripId: string;
  followerVehicleId?: string;
  holdSeconds: number;
  until: number;
  reason: string;
}

export interface DecideTripletsOptions {
  nowSvc: number;
  leadTimeSeconds: number;
  maxHoldSeconds: number;
}

function formatMinutes(seconds: number): string {
  const mins = Math.round(seconds / 60);
  return `${mins} min`;
}

export function decideTriplets(
  ordered: DispatchDeparture[],
  opts: DecideTripletsOptions,
): TripletDecision[] {
  const working = ordered.map((d) => ({ ...d }));
  const decisions: TripletDecision[] = [];
  for (let i = 1; i < working.length - 1; i++) {
    const center = working[i]!;
    if (center.state === 'departed') continue;
    if (center.hold) continue;
    if (opts.nowSvc < center.edt - opts.leadTimeSeconds) continue;

    const leader = working[i - 1]!;
    const follower = working[i + 1]!;
    const forwardHeadway = center.edt - effectiveDeparture(leader);
    const backwardHeadway = follower.edt - center.edt;
    const seconds = holdSeconds(backwardHeadway, forwardHeadway, opts.maxHoldSeconds);
    if (seconds > 0) {
      const until = center.edt + seconds;
      center.hold = { holdSeconds: seconds, effectiveDeparture: until, reason: '' };
      decisions.push({
        tripId: center.tripId,
        vehicleId: center.vehicleId,
        leaderTripId: leader.tripId,
        leaderVehicleId: leader.vehicleId,
        followerTripId: follower.tripId,
        followerVehicleId: follower.vehicleId,
        holdSeconds: seconds,
        until,
        reason:
          `Gap behind is ${formatMinutes(backwardHeadway)} vs ${formatMinutes(forwardHeadway)} ahead; ` +
          `hold the center ${formatMinutes(seconds)} to even headways`,
      });
    }
  }
  return decisions;
}
