// Liveness watchdog for the tick loops.
//
// A refresh cycle that never settles wedges both tick loops permanently: runRefresh coalesces
// every tick onto the in-flight promise, and each loop reschedules only when that promise
// settles. Production hit exactly this on 2026-10-08 — a feed fetch hung past its 15 s
// AbortController (the abort signal cannot interrupt a fetch stuck in DNS/connect
// resolution), freezing the collector at zero CPU until a manual restart. The watchdog exits
// the process after `staleMs` without a completed tick so the platform's restart policy brings
// the collector back within seconds; the structural fix (unconditional timer rescheduling
// plus raced in-flight clearing) is plan Phase 10e.
export interface WatchdogDeps {
  /** How often to inspect the last completed tick (at most the fastest loop interval). */
  intervalMs: number;
  /** Completed-tick staleness after which onStale fires once (and the watchdog disarms). */
  staleMs: number;
  onStale: (staleSeconds: number) => void;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => void;
}

export interface Watchdog {
  /** Record a completed tick (fact or decision refresh); resets the staleness window. */
  touch(): void;
}

export function createWatchdog(deps: WatchdogDeps): Watchdog {
  const now = deps.now ?? Date.now;
  const setTimer =
    deps.setTimer ?? ((callback: () => void, ms: number) => { setTimeout(callback, ms); });
  let lastTickAt = now();
  let armed = true;

  function check(): void {
    if (!armed) return;
    const staleMs = now() - lastTickAt;
    if (staleMs >= deps.staleMs) {
      // One-shot: the production wiring exits the process, so rescheduling here would only
      // spam the callback after a failed exit.
      armed = false;
      deps.onStale(Math.round(staleMs / 1000));
      return;
    }
    setTimer(check, deps.intervalMs);
  }

  setTimer(check, deps.intervalMs);
  return {
    touch() {
      lastTickAt = now();
    },
  };
}
