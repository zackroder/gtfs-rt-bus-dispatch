import type { HoldOverride } from '../../../shared/types';

// This file is the single source of truth for EDT and the middle-bus hold rule.
export interface DispatchDeparture {
  tripId: string;
  vehicleId?: string;
  state: 'incoming' | 'layover' | 'departed';
  scheduledDeparture: number;
  terminalArrival?: number;
  arrivalSource?: 'observed' | 'estimated';
  edt: number;
  departedSeconds?: number;
  hold?: HoldOverride;
  departurePending?: boolean;
}

// Calculate the earliest departure allowed by schedule and minimum terminal rest.
export function expectedDepartureTime(
  scheduledDeparture: number,
  terminalArrival: number | undefined,
  minRestSeconds: number,
): number {
  // A bus cannot leave before its minimum rest, but an unknown arrival must not delay it.
  if (terminalArrival === undefined) return scheduledDeparture;
  return Math.max(scheduledDeparture, terminalArrival + minRestSeconds);
}

// Calculate a capped, 30-second-rounded hold for the center bus of a triplet.
export function holdSeconds(
  backwardHeadway: number,
  forwardHeadway: number,
  maxHoldSeconds: number,
): number {
  // Hold only the center of a triplet, splitting the excess trailing gap while respecting
  // the configured cap and the one-minute minimum useful intervention.
  const raw = Math.min(Math.max((backwardHeadway - forwardHeadway) / 2, 0), maxHoldSeconds);
  if (raw < 60) return 0;
  return Math.min(Math.round(raw / 30) * 30, maxHoldSeconds);
}

// Return the departure timestamp that should participate in a headway calculation.
export function effectiveDeparture(departure: DispatchDeparture): number {
  // Decisions use actual departure for departed buses, then an approved hold, then EDT.
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
  requireObservedArrival?: boolean;
}

function formatMinutes(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${mins} min` : `${mins} min ${remainder} sec`;
}

// Evaluate adjacent departure triplets and produce actionable middle-bus hold decisions.
export function decideTriplets(
  ordered: DispatchDeparture[],
  opts: DecideTripletsOptions,
): TripletDecision[] {
  const working = ordered.map((d) => ({ ...d }));
  const decisions: TripletDecision[] = [];
  for (let i = 1; i < working.length - 1; i++) {
    const center = working[i]!;
    if (center.state === 'departed') continue;
    if (center.departurePending) continue;
    if (center.hold) continue;
    if (opts.requireObservedArrival && center.arrivalSource !== 'observed') continue;
    // Production engine calls requireObservedArrival so a recommendation is never based solely
    // on a speculative arrival estimate.
    if (opts.nowSvc < center.edt - opts.leadTimeSeconds) continue;

    const leader = working[i - 1]!;
    const follower = working[i + 1]!;
    const forwardHeadway = center.edt - effectiveDeparture(leader);
    const backwardHeadway = follower.edt - center.edt;
    // Headways are measured around the center departure; the working copy lets an earlier
    // decision affect the next triplet without mutating the caller's input.
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
