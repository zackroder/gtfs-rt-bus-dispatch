/** Shared wall-clock hook used by every live countdown in the terminal view. */
import { useEffect, useState } from 'react';

// One timer serves all mounted countdowns, avoiding one interval per card.
let currentNow = Math.floor(Date.now() / 1000);
const listeners = new Set<(value: number) => void>();
let timer: number | undefined;

function startClock(): void {
  if (timer !== undefined) return;
  timer = window.setInterval(() => {
    // Use epoch seconds so countdowns remain aligned with server-generated timestamps.
    currentNow = Math.floor(Date.now() / 1000);
    for (const listener of listeners) listener(currentNow);
  }, 1000);
}

function stopClock(): void {
  if (listeners.size !== 0 || timer === undefined) return;
  window.clearInterval(timer);
  timer = undefined;
}

export function useNow(intervalMs = 1000): number {
  // intervalMs is retained in the hook API for callers, while the shared clock
  // intentionally ticks once per second for all subscribers.
  const [now, setNow] = useState(currentNow);
  useEffect(() => {
    listeners.add(setNow);
    startClock();
    return () => {
      listeners.delete(setNow);
      stopClock();
    };
  }, [intervalMs]);
  return now;
}

export function useCountdown(seconds: number, generatedAt: number): number {
  const now = useNow();
  // The server supplies seconds remaining at snapshot generation time; subtract
  // elapsed wall-clock seconds so a snapshot continues counting between pushes.
  return seconds - (now - generatedAt);
}
