import { describe, expect, it } from 'vitest';
import { computeInterventions } from './interventions';
import type { OutboundDeparture } from './headway';
import type { InterventionContext } from './interventions';

function dep(overrides: Partial<OutboundDeparture>): OutboundDeparture {
  return {
    tripId: 'T',
    routeId: '1',
    scheduledDeparture: 0,
    predictedDeparture: 0,
    scheduledArrival: 0,
    predictedArrival: 0,
    hasArrivalInfo: false,
    state: 'unknown',
    minRest: false,
    ...overrides,
  };
}

function ctx(overrides: Partial<InterventionContext> = {}): InterventionContext {
  return {
    terminalId: 'T',
    routeId: '1',
    nowSvc: 1000,
    generatedAt: 1700000000,
    rules: {
      gapFactor: 1.5,
      bunchFactor: 0.5,
      holdFraction: 0.5,
      maxHoldMinutes: 10,
      leadTimeMinutes: 5,
      minRestMinutes: 5,
    },
    ...overrides,
  };
}

describe('computeInterventions', () => {
  it('computes holds from raw predicted departures without cascading', () => {
    const nowSvc = 7000;
    const departures = [
      dep({ tripId: 'D1', scheduledDeparture: 7200, predictedDeparture: 7200, state: 'unknown' }),
      dep({
        tripId: 'D2',
        scheduledDeparture: 7920,
        predictedDeparture: 9000,
        state: 'unknown',
        prevTripId: 'P2',
      }),
      dep({
        tripId: 'D3',
        scheduledDeparture: 8640,
        predictedDeparture: 8640,
        state: 'layover',
        prevTripId: 'P3',
        hasArrivalInfo: true,
      }),
    ];

    const result = computeInterventions(departures, ctx({ nowSvc }));

    const heldLeader = result.departures.find((d) => d.tripId === 'D1')!;
    expect(heldLeader.hold).toBeDefined();
    expect(heldLeader.hold!.holdSeconds).toBe(540);

    const middle = result.departures.find((d) => d.tripId === 'D2')!;
    expect(middle.hold).toBeUndefined();
    expect(middle.predictedDeparture).toBe(9000);

    const heldFollower = result.departures.find((d) => d.tripId === 'D3')!;
    expect(heldFollower.hold).toBeDefined();
    expect(heldFollower.hold!.rule).toBe('follower');

    expect(result.interventions.filter((i) => i.rule === 'hold_leader')).toHaveLength(1);
    expect(result.interventions.filter((i) => i.rule === 'hold_follower')).toHaveLength(1);
  });
});
