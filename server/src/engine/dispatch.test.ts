import { describe, expect, it } from 'vitest';
import {
  decideTriplets,
  expectedDepartureTime,
  holdSeconds,
  suggestionExpiresAt,
  type DispatchDeparture,
  type TripletDecision,
} from './dispatch';
import type { HoldOverride } from '../../../shared/types';

// Dispatch fixtures use service-day seconds directly so each assertion isolates EDT/headway math.
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

describe('suggestionExpiresAt', () => {
  it('expires a live decision when its hold window ends', () => {
    expect(suggestionExpiresAt(720, 600, 1000)).toBe(1120);
  });

  it('expires a degenerate decision immediately instead of wrapping into a day', () => {
    // until already in the past: the old modulo form produced roughly generatedAt + 86400.
    expect(suggestionExpiresAt(600, 720, 1000)).toBe(1000);
    expect(suggestionExpiresAt(720, 720, 1000)).toBe(1000);
  });
});

describe('decideTriplets', () => {
  // Triplet fixtures deliberately include a departed leader and future followers to model the
  // operational middle-bus recommendation rather than a generic spacing algorithm.
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
      dep({ tripId: 'D4', state: 'layover', edt: 820 }),
    ];
    const opts = { nowSvc: 100000, leadTimeSeconds: 0, maxHoldSeconds: MAX_HOLD };

    const unheld = decideTriplets(base, opts);
    expect(unheld).toEqual([]);

    const held = decideTriplets(
      base.map((d) => (d.tripId === 'D2' ? { ...d, hold: locked(120, 420) } : d)),
      opts,
    );
    expect(ids(held)).toEqual(['D3']);
    expect(held[0]!.holdSeconds).toBe(60);
    expect(held[0]!.until).toBe(610);
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
    expect(ids(decisions)).toEqual(['D2']);
    expect(decisions.every((d) => d.tripId !== 'D1' && d.tripId !== 'D4')).toBe(true);
  });

  it('rounds holds to 30-second increments and suppresses holds under one minute', () => {
    expect(holdSeconds(118, 0, MAX_HOLD)).toBe(0);
    expect(holdSeconds(119, 0, MAX_HOLD)).toBe(0);
    expect(holdSeconds(120, 0, MAX_HOLD)).toBe(60);
    expect(holdSeconds(121, 0, MAX_HOLD)).toBe(60);
    expect(holdSeconds(149, 0, MAX_HOLD)).toBe(60);
    expect(holdSeconds(150, 0, MAX_HOLD)).toBe(90);
    expect(holdSeconds(119, 0, 119)).toBe(0);
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

  // A follower can physically depart while the center is still at the terminal. Both headways
  // must then use actual departures; measuring the backward gap from raw EDT produced holds
  // that recommended departing after a follower that was already gone.
  it('ignores the EDT of a follower that departed early and suppresses the hold', () => {
    const departures = [
      dep({ tripId: 'D1', state: 'departed', departedSeconds: 240, edt: 240 }),
      dep({ tripId: 'D2', state: 'layover', edt: 540 }),
      dep({ tripId: 'D3', state: 'departed', departedSeconds: 660, edt: 1440 }),
    ];
    const decisions = decideTriplets(departures, {
      nowSvc: 540,
      leadTimeSeconds: 0,
      maxHoldSeconds: MAX_HOLD,
    });
    // Raw EDT would claim a 15 min backward gap and hold D2 until 840 — past D3's actual 660.
    expect(ids(decisions)).toEqual([]);
  });

  it('sizes the hold from a departed follower\'s actual departure and never passes it', () => {
    const departures = [
      dep({ tripId: 'D1', state: 'departed', departedSeconds: 540, edt: 540 }),
      dep({ tripId: 'D2', state: 'layover', edt: 600 }),
      dep({ tripId: 'D3', state: 'departed', departedSeconds: 900, edt: 840 }),
    ];
    const decisions = decideTriplets(departures, {
      nowSvc: 600,
      leadTimeSeconds: 0,
      maxHoldSeconds: MAX_HOLD,
    });
    expect(ids(decisions)).toEqual(['D2']);
    expect(decisions[0]!.holdSeconds).toBe(120);
    expect(decisions[0]!.until).toBe(720);
    // The recommendation must never hold the center beyond the follower's real departure.
    expect(decisions[0]!.until).toBeLessThan(900);
  });
});
