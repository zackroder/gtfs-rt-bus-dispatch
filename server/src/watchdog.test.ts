import { describe, expect, it } from 'vitest';
import { createWatchdog, type WatchdogDeps } from './watchdog';

// Manual fake clock: timers queue with absolute due times and run in order when advanced.
class FakeClock {
  now = 0;
  private queue: Array<{ at: number; run: () => void }> = [];
  readonly setTimer: WatchdogDeps['setTimer'] = (run, ms) => {
    this.queue.push({ at: this.now + ms, run });
  };
  readonly nowFn: WatchdogDeps['now'] = () => this.now;
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const next = this.queue.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.now = next.at;
      this.queue = this.queue.filter((t) => t !== next);
      next.run();
    }
    this.now = target;
  }
}

function setup(staleMs = 180_000, intervalMs = 10_000) {
  const clock = new FakeClock();
  const stale: number[] = [];
  const watchdog = createWatchdog({
    intervalMs,
    staleMs,
    now: clock.nowFn,
    setTimer: clock.setTimer,
    onStale: (seconds) => stale.push(seconds),
  });
  return { clock, watchdog, stale };
}

describe('tick watchdog', () => {
  it('fires once after the stale window with no completed tick', () => {
    const { clock, stale } = setup();
    clock.advance(180_000);
    expect(stale).toEqual([180]);
    // Disarmed after firing: no repeated callbacks.
    clock.advance(600_000);
    expect(stale).toEqual([180]);
  });

  it('touch resets the staleness window', () => {
    const { clock, watchdog, stale } = setup();
    clock.advance(170_000);
    expect(stale).toEqual([]);
    watchdog.touch();
    // Only time since the last touch counts: 170 s of silence after a touch is fine.
    clock.advance(170_000);
    expect(stale).toEqual([]);
    // 180 s since the touch fires, reporting time since the touch (180), not since start.
    clock.advance(30_000);
    expect(stale).toEqual([180]);
  });

  it('never fires while ticks complete within the window', () => {
    const { clock, watchdog, stale } = setup();
    for (let i = 0; i < 50; i++) {
      clock.advance(10_000);
      watchdog.touch();
    }
    expect(stale).toEqual([]);
  });
});
