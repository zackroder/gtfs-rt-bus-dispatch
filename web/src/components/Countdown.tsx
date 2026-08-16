/** Accessible text countdown that derives its current value from the shared clock. */
import { useCountdown } from '../hooks/useCountdown';
import { pad } from '../format';

export function Countdown({ seconds, generatedAt }: { seconds: number; generatedAt: number }) {
  const remaining = useCountdown(seconds, generatedAt);
  // Color thresholds communicate urgency without changing the underlying seconds.
  const tone = remaining > 120 ? 'ok' : remaining >= 0 ? 'warn' : 'late';
  // Do not show negative time; the late class still communicates that the deadline passed.
  const minutes = Math.floor(Math.max(0, remaining) / 60);
  const secs = Math.max(0, remaining) % 60;
  return (
    <span className={`countdown ${tone}`}>
      {pad(minutes)}:{pad(secs)}
    </span>
  );
}
