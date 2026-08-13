export function pad(value: number): string {
  return String(Math.max(0, value)).padStart(2, '0');
}

export function formatClock(serviceSeconds: number): string {
  const hours = Math.floor(serviceSeconds / 3600) % 24;
  const minutes = Math.floor((serviceSeconds % 3600) / 60);
  return `${pad(hours)}:${pad(minutes)}`;
}

export function formatHold(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `+${minutes}:${pad(remainder)}`;
}

export function formatDelay(seconds: number): string {
  const sign = seconds > 0 ? '+' : seconds < 0 ? '-' : '';
  const minutes = Math.round(Math.abs(seconds) / 60);
  if (minutes === 0) return 'on time';
  return `${sign}${minutes} min`;
}
