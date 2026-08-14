import { describe, expect, it } from 'vitest';
import {
  decideTriplets,
  expectedDepartureTime,
  holdSeconds,
  type DispatchDeparture,
  type TripletDecision,
} from './dispatch';
import type { HoldOverride } from '../../../shared/types';

const MIN_REST = 300;
const LEAD = 300;
const MAX_HOLD = 600;

function dep(overrides: Partial<DispatchDeparture>): DispatchDeparture {
  return {
    tripId: 'D',
    state: 'layover',
    scheduledDeparture: 0,
    terminalArrival: 0,
    edt: 0,
    ...overrides,
  };
}

function locked(holdSeconds: number, until: number): HoldOverride {
  return { holdSeconds, effectiveDeparture: until, reason: 'locked' };
}

function ids(decisions: TripletDecision[]): string[] {
  return decisions.map((d) => d.tripId);
}

describe('expectedDepartureTime', () => {
  it('returns scheduled when arrival + rest leaves room', () => {
    expect(expectedDepartureTime(1800, 1500, MIN_REST)).toBe(1800);
  });

  it('returns arrival + rest when it exceeds scheduled (rest-delayed)', () => {
    expect(expectedDepartureTime(0, 0, MIN_REST)).toBe(300);
  });

  it('falls back to scheduled when arrival is unknown', () => {
    expect(expectedDepartureTime(600, undefined, MIN_REST)).toBe(600);
  });
});

describe('holdSeconds', () => {
  it('floors at 0 and never dispatches early', () => {
    expect(holdSeconds(100, 300, MAX_HOLD)).toBe(0);
    expect(holdSeconds(0, 100, MAX_HOLD)).toBe(0);
  });

  it('caps at maxHoldMinutes', () => {
    expect(holdSeconds(4000, 0, MAX_HOLD)).toBe(600);
  });
});

describe('decideTriplets', () => {
  it('reproduces the README worked example', () => {
    const departures = [
      dep({ tripId: 'D1', state: 'departed', departedSeconds: 300, edt: 300 }),
      dep({ tripId: 'D2', state: 'layover', edt: 720 }),
      dep({ tripId: 'D3', state: 'layover', edt: 1380 }),
      dep({ tripId: 'D4', state: 'layover', edt: 1800 }),
    ];

    const first = decideTriplets(departures, {
      nowSvc: 720,
      leadTimeSeconds: LEAD,
      maxHoldSeconds: MAX_HOLD,
    });
    expect(ids(first)).toEqual(['D2']);
    expect(first[0]!.holdSeconds).toBe(120);
    expect(first[0]!.until).toBe(840);

    const withLock = departures.map((d) =>
      d.tripId === 'D2' ? { ...d, hold: locked(120, 840) } : d,
    );
    const second = decideTriplets(withLock, {
      nowSvc: 1080,
      leadTimeSeconds: LEAD,
      maxHoldSeconds: MAX_HOLD,
    });
    expect(second).toEqual([]);
  });

  it('propagates a locked leader hold left-to-right', () => {
    const base = [
      dep({ tripId: 'D1', state: 'departed', departedSeconds: 0, edt: 0 }),
      dep({ tripId: 'D2', state: 'layover', edt: 300 }),
      dep({ tripId: 'D3', state: 'layover', edt: 550 }),
      dep({ tripId: 'D4', state: 'layover', edt: 700 }),
    ];
    const opts = { nowSvc: 100000, leadTimeSeconds: 0, maxHoldSeconds: MAX_HOLD };

    const unheld = decideTriplets(base, opts);
    expect(unheld).toEqual([]);

    const held = decideTriplets(
      base.map((d) => (d.tripId === 'D2' ? { ...d, hold: locked(120, 420) } : d)),
      opts,
    );
    expect(ids(held)).toEqual(['D3']);
    expect(held[0]!.holdSeconds).toBe(10);
    expect(held[0]!.until).toBe(560);
  });

  it('never holds the first or last departure', () => {
    const departures = [
      dep({ tripId: 'D1', state: 'departed', departedSeconds: 100, edt: 100 }),
      dep({ tripId: 'D2', state: 'layover', edt: 200 }),
      dep({ tripId: 'D3', state: 'layover', edt: 500 }),
      dep({ tripId: 'D4', state: 'layover', edt: 800 }),
    ];
    const decisions = decideTriplets(departures, {
      nowSvc: 100000,
      leadTimeSeconds: 0,
      maxHoldSeconds: MAX_HOLD,
    });
    expect(ids(decisions)).toEqual(['D2', 'D3']);
    expect(decisions.every((d) => d.tripId !== 'D1' && d.tripId !== 'D4')).toBe(true);
  });

  it('opens the trigger window from EDT, not scheduled', () => {
    const departures = [
      dep({ tripId: 'D1', state: 'departed', departedSeconds: 300, edt: 300 }),
      dep({ tripId: 'D2', state: 'layover', edt: 720 }),
      dep({ tripId: 'D3', state: 'layover', edt: 1380 }),
    ];

    expect(
      decideTriplets(departures, { nowSvc: 419, leadTimeSeconds: LEAD, maxHoldSeconds: MAX_HOLD }),
    ).toEqual([]);
    expect(
      decideTriplets(departures, { nowSvc: 420, leadTimeSeconds: LEAD, maxHoldSeconds: MAX_HOLD }),
    ).toHaveLength(1);
  });

  it('does not re-derive a locked hold', () => {
    const departures = [
      dep({ tripId: 'D1', state: 'departed', departedSeconds: 0, edt: 0 }),
      dep({ tripId: 'D2', state: 'layover', edt: 300, hold: locked(999, 500) }),
      dep({ tripId: 'D3', state: 'layover', edt: 900 }),
    ];
    const decisions = decideTriplets(departures, {
      nowSvc: 300,
      leadTimeSeconds: LEAD,
      maxHoldSeconds: MAX_HOLD,
    });
    expect(ids(decisions)).toEqual([]);
  });
});
