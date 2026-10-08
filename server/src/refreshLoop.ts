// Serialized refresh loops with unconditional scheduling, hard abandon, and zombie guards.
//
// The structural fix for the 2026-10-08 production wedge: a refresh that never settles
// (e.g. a feed fetch hung past its AbortController) froze both tick loops permanently,
// because every tick coalesced onto the in-flight promise and each loop rescheduled only
// in that promise's `.finally`. Three properties make a hung cycle harmless now:
// 1. Ticks reschedule themselves before acting — nothing that happens inside a cycle can
//    stop a loop.
// 2. A cycle is raced against a hard abandon timeout: the slot frees so the next tick
//    starts a fresh generation (a bounded data gap, never a permanent freeze).
// 3. Generation guards: an abandoned cycle that settles late (a zombie) cannot clear a
//    newer generation's slot, drain decision waiters, or requeue decisions — runCycle
//    receives isCurrent() and must gate its shared-state writes on it.
// The liveness watchdog (server/src/watchdog.ts) remains as belt-and-braces: it is the
// only cure for the synchronous-hang class, which timers cannot preempt at all.

export interface RefreshLoopDeps {
  /** One cycle; may never settle. Must gate shared-state writes on isCurrent(). */
  runCycle: (decisions: boolean, isCurrent: () => boolean) => Promise<void>;
  factIntervalMs: () => number;
  decisionIntervalMs: () => number;
  /** Hard per-cycle timeout: the slot frees and the next tick starts a fresh generation. */
  abandonAfterMs: number;
  onError?: (source: string, err: unknown) => void;
  onAbandon?: (generation: number, decisions: boolean, waitedMs: number) => void;
  now?: () => number;
  /** Schedules a callback; returns a cancel function (so tests can drive a fake clock). */
  setTimer?: (callback: () => void, ms: number) => () => void;
}

export interface RefreshLoops {
  /** Request a decision cycle; coalesces behind a running cycle and settles within one
   * cycle (or the abandon bound) — callers can never hang on a wedged loop again. */
  requestDecision(): Promise<void>;
  /** True while a cycle holds the slot (a fact or decision pass is running). Health/diagnostics. */
  isRunning(): boolean;
  stop(): void;
}

export function startRefreshLoops(deps: RefreshLoopDeps): RefreshLoops {
  const now = deps.now ?? Date.now;
  const setTimer =
    deps.setTimer ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    });

  let stopped = false;
  let generation = 0;
  let running: { generation: number; decisions: boolean } | null = null;
  let decisionQueued = false;
  let decisionWaiters: Array<() => void> = [];

  function isCurrent(gen: number): boolean {
    return !stopped && running !== null && running.generation === gen;
  }

  function drainWaiters(): void {
    const waiters = decisionWaiters;
    decisionWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function maybeRunQueuedDecision(): void {
    if (stopped || running !== null || !decisionQueued) return;
    decisionQueued = false;
    startCycle(true);
  }

  function startCycle(decisions: boolean): void {
    if (stopped) return;
    const gen = ++generation;
    running = { generation: gen, decisions };
    const startedAt = now();
    const isCur = () => isCurrent(gen);

    const cancelAbandon = setTimer(() => {
      if (!isCurrent(gen)) return;
      // Hard abandon: free the slot so the next tick (or a queued decision) starts a
      // fresh generation; bumping the generation invalidates the zombie's isCurrent().
      const waitedMs = now() - startedAt;
      running = null;
      generation++;
      deps.onAbandon?.(gen, decisions, waitedMs);
      drainWaiters();
      maybeRunQueuedDecision();
    }, deps.abandonAfterMs);

    void (async () => {
      try {
        await deps.runCycle(decisions, isCur);
      } catch (err) {
        // Zombie errors are muted: the generation that abandoned it owns the state now.
        if (isCur()) deps.onError?.(decisions ? 'decision tick' : 'fact tick', err);
      } finally {
        cancelAbandon();
        if (isCurrent(gen)) {
          const wasDecisions = running?.decisions === true;
          running = null;
          if (wasDecisions) drainWaiters();
          maybeRunQueuedDecision();
        }
        // A zombie settling late (its generation was bumped by its abandon timer) must
        // touch nothing: not the newer slot, not the waiters, not the decision queue.
      }
    })();
  }

  function onTick(decisions: boolean): void {
    if (stopped) return;
    if (running !== null) {
      // A cycle is in flight: facts are already being recorded by it; a decision tick on
      // a busy slot queues a decision to run immediately after — never dropped.
      if (decisions) decisionQueued = true;
      return;
    }
    startCycle(decisions);
  }

  function schedule(kind: 'fact' | 'decision'): void {
    if (stopped) return;
    const intervalMs = kind === 'fact' ? deps.factIntervalMs() : deps.decisionIntervalMs();
    setTimer(() => {
      // Reschedule before acting: whatever happens inside a cycle, the loop keeps ticking.
      schedule(kind);
      onTick(kind === 'decision');
    }, intervalMs);
  }

  schedule('fact');
  schedule('decision');

  function requestDecision(): Promise<void> {
    const done = new Promise<void>((resolve) => {
      decisionWaiters.push(resolve);
    });
    if (stopped) {
      drainWaiters();
    } else if (running !== null) {
      decisionQueued = true;
    } else {
      startCycle(true);
    }
    return done;
  }

  return {
    requestDecision,
    isRunning: () => running !== null,
    stop() {
      stopped = true;
      running = null;
      generation++;
      drainWaiters();
    },
  };
}
