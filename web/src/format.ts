/** Display formatters for service-day seconds and operator-facing status labels. */

export function pad(value: number): string {
  return String(Math.max(0, value)).padStart(2, '0');
}

export function formatClock(serviceSeconds: number, serviceDayStartSeconds: number): string {
  // Service seconds may cross midnight; normalize to a wall-clock day before formatting.
  const wallClock = ((serviceSeconds + serviceDayStartSeconds) % 86400 + 86400) % 86400;
  const hours = Math.floor(wallClock / 3600);
  const minutes = Math.floor((wallClock % 3600) / 60);
  return `${pad(hours)}:${pad(minutes)}`;
}

export function formatHold(seconds: number): string {
  // Holds are operationally discussed in 30-second increments rather than raw decimals.
  const rounded = Math.round(seconds / 30) * 30;
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return `+${minutes}:${pad(remainder)}`;
}

export function formatDelay(seconds: number): string {
  // Round only the displayed minute while retaining the sign for early/late status.
  const sign = seconds > 0 ? '+' : seconds < 0 ? '-' : '';
  const minutes = Math.round(Math.abs(seconds) / 60);
  if (minutes === 0) return 'on time';
  return `${sign}${minutes} min`;
}
