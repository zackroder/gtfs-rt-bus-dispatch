import { describe, expect, it } from 'vitest';
import { startRefreshLoops, type RefreshLoopDeps } from './refreshLoop';

// Manual fake clock with cancellable timers. Timers queue with absolute due times; `advance` runs
// every due timer in order and flushes microtasks after each so async cycles make progress.
class FakeClock {
  now = 0;
  private nextId = 0;
  private queue = new Map<number, { at: number; run: () => void }>();
  readonly setTimer: NonNullable<RefreshLoopDeps['setTimer']> = (run, ms) => {
    const id = ++this.nextId;
    this.queue.set(id, { at: this.now + ms, run });
    return () => this.queue.delete(id);
  };
  readonly nowFn: NonNullable<RefreshLoopDeps['now']> = () => this.now;

  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.queue.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at);
      const next = due[0];
      if (!next) break;
      this.queue.delete(next[0]);
      this.now = next[1].at;
      next[1].run();
      await flushMicrotasks();
    }
    this.now = target;
    await flushMicrotasks();
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

interface StartedCycle {
  decisions: boolean;
  isCurrent: () => boolean;
  resolve: () => void;
}

// Harness that records every cycle start and lets tests settle cycles by hand (a cycle whose
// promise never resolves models the production wedge).
function setup(overrides: Partial<RefreshLoopDeps> = {}) {
  const clock = new FakeClock();
  const cycles: StartedCycle[] = [];
  const abandons: number[] = [];
  const errors: string[] = [];
  const loops = startRefreshLoops({
    runCycle: (decisions, isCurrent) =>
      new Promise<void>((resolve) => {
        cycles.push({ decisions, isCurrent, resolve });
      }),
    factIntervalMs: () => 1000,
    decisionIntervalMs: () => 1000,
    abandonAfterMs: 500,
    now: clock.nowFn,
    setTimer: clock.setTimer,
    onAbandon: (generation) => abandons.push(generation),
    onError: (source, err) => errors.push(`${source}:${(err as Error).message}`),
    ...overrides,
  });
  return { clock, loops, cycles, abandons, errors };
}

describe('refresh loops', () => {
  it('a never-settling cycle cannot stop the loops; ticks keep firing and start fresh generations', async () => {
    const { clock, loops, cycles, abandons } = setup();
    await clock.advance(1000);
    expect(cycles).toHaveLength(1);
    await clock.advance(2000);
    // The first generation was abandoned at 1500 and a later tick started a fresh one.
    expect(abandons.length).toBeGreaterThanOrEqual(1);
    expect(cycles.length).toBeGreaterThanOrEqual(2);
    // Every cycle that started is still individually alive (none was resolved in this test).
    expect(loops.isRunning()).toBe(true);
    loops.stop();
  });

  it('frees the slot on abandon so a queued decision starts a new generation immediately', async () => {
    const { clock, loops, cycles, abandons } = setup();
    await clock.advance(1000);
    const first = cycles[0]!;
    // Advance exactly to the abandon bound; no tick has fired yet to start a replacement.
    await clock.advance(500);
    expect(abandons).toHaveLength(1);
    expect(first.isCurrent()).toBe(false);

    const waiter = loops.requestDecision();
    let settled = false;
    void waiter.then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(cycles).toHaveLength(2);
    expect(cycles[1]!.decisions).toBe(true);
    expect(loops.isRunning()).toBe(true);
    expect(settled).toBe(false);
    loops.stop();
  });

  it('a late-settling zombie cannot clear a newer slot, drain waiters, or requeue decisions', async () => {
    const { clock, loops, cycles, abandons } = setup();
    await clock.advance(1000);
    const zombie = cycles[0]!;
    await clock.advance(500); // abandon the first generation
    expect(abandons).toHaveLength(1);
    expect(zombie.isCurrent()).toBe(false);

    const waiter = loops.requestDecision();
    let settled = false;
    void waiter.then(() => {
      settled = true;
    });
    await flushMicrotasks();
    const live = cycles[1]!;
    expect(loops.isRunning()).toBe(true);

    // The zombie settles late: gen1 is not current, so it must touch nothing.
    zombie.resolve();
    await flushMicrotasks();
    expect(zombie.isCurrent()).toBe(false);
    expect(loops.isRunning()).toBe(true);
    expect(settled).toBe(false);

    // The live generation settling resolves the waiter.
    live.resolve();
    await flushMicrotasks();
    expect(settled).toBe(true);
    loops.stop();
  });

  it('runs a decision requested during a fact cycle immediately after and resolves its waiters', async () => {
    const { clock, loops, cycles } = setup({ decisionIntervalMs: () => 30_000, abandonAfterMs: 60_000 });
    await clock.advance(1000);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.decisions).toBe(false);

    const waiter = loops.requestDecision();
    let settled = false;
    void waiter.then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(cycles).toHaveLength(1); // queued, not started in parallel

    cycles[0]!.resolve(); // finish the fact cycle
    await flushMicrotasks();
    expect(cycles).toHaveLength(2);
    expect(cycles[1]!.decisions).toBe(true);
    expect(settled).toBe(false); // the decision cycle is still running

    cycles[1]!.resolve();
    await flushMicrotasks();
    expect(settled).toBe(true);
    loops.stop();
  });

  it('cycle errors are reported but never stop the loops', async () => {
    let attempts = 0;
    const { clock, loops, errors } = setup({
      runCycle: async () => {
        attempts++;
        if (attempts === 1) throw new Error('boom');
      },
      decisionIntervalMs: () => 30_000,
      abandonAfterMs: 60_000,
    });
    await clock.advance(1000);
    expect(attempts).toBe(1);
    expect(errors).toEqual(['fact tick:boom']);
    await clock.advance(1000);
    expect(attempts).toBe(2);
    loops.stop();
  });

  it('stop halts the loops and resolves pending waiters', async () => {
    let attempts = 0;
    const pending: Array<() => void> = [];
    const { clock, loops } = setup({
      runCycle: (decisions) => {
        attempts++;
        if (decisions) return new Promise<void>((resolve) => pending.push(resolve));
        return Promise.resolve();
      },
    });
    const waiter = loops.requestDecision();
    let settled = false;
    void waiter.then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(attempts).toBe(1);

    loops.stop();
    await flushMicrotasks();
    expect(settled).toBe(true);
    expect(loops.isRunning()).toBe(false);
    await clock.advance(5000);
    expect(attempts).toBe(1);
  });
});
