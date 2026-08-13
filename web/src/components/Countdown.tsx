import { useCountdown } from '../hooks/useCountdown';
import { pad } from '../format';

export function Countdown({ seconds, generatedAt }: { seconds: number; generatedAt: number }) {
  const remaining = useCountdown(seconds, generatedAt);
  const tone = remaining > 120 ? 'ok' : remaining >= 0 ? 'warn' : 'late';
  const minutes = Math.floor(Math.max(0, remaining) / 60);
  const secs = Math.max(0, remaining) % 60;
  return (
    <span className={`countdown ${tone}`}>
      {pad(minutes)}:{pad(secs)}
    </span>
  );
}
