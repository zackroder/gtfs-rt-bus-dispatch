/**
 * Operator-facing intervention recommendation and action controls.
 *
 * The server remains the source of truth for lifecycle transitions; local status
 * makes the card respond immediately while the next snapshot reconciles it.
 */
import { useEffect, useState } from 'react';
import type { Intervention } from '../../../shared/types';
import { formatClock, formatHold } from '../format';
import {
  applyIntervention,
  cancelIntervention,
  declineIntervention,
  viewIntervention,
} from '../api';

export function InterventionCard({
  intervention,
  serviceDayStartSeconds,
  onChanged,
}: {
  intervention: Intervention;
  serviceDayStartSeconds: number;
  onChanged?: () => void;
}) {
  // Keep local status synchronized when a refreshed snapshot changes the durable state.
  const [status, setStatus] = useState(intervention.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setStatus(intervention.status);
  }, [intervention.status]);

  useEffect(() => {
    // Viewing is an intentional audit event, even though it does not change the card.
    void viewIntervention(intervention.id).catch(() => undefined);
  }, [intervention.id]);

  const act = async (action: 'apply' | 'decline' | 'cancel') => {
    // Disable all controls for the request so one recommendation cannot receive
    // competing transitions from repeated clicks.
    setBusy(true);
    setError(null);
    try {
      const result = action === 'apply'
        ? await applyIntervention(intervention.id)
        : action === 'decline'
          ? await declineIntervention(intervention.id)
          : await cancelIntervention(intervention.id);
      setStatus(result.status);
      // Let the parent refresh surrounding route data after the server accepts the action.
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="intervention">
      <div className="intervention-title">
        Hold {intervention.vehicleId ?? 'bus'} until{' '}
        {intervention.until !== undefined
          ? formatClock(intervention.until, serviceDayStartSeconds)
          : ''}{' '}
        ({formatHold(intervention.holdSeconds)})
      </div>
      <div className="intervention-reason">{intervention.reason}</div>
      {/* The status remains visible as text for users and is styled separately by lifecycle state. */}
      <div className={`intervention-status status-${status}`}>{status}</div>
      {status === 'pending' && (
        <div className="intervention-actions">
          {/* Native buttons provide keyboard activation and disabled-state semantics. */}
          <button type="button" disabled={busy} onClick={() => void act('apply')}>
            Apply hold
          </button>
          <button type="button" disabled={busy} onClick={() => void act('decline')}>
            Decline
          </button>
          <button type="button" disabled={busy} onClick={() => void act('cancel')}>
            Cancel
          </button>
        </div>
      )}
      {status === 'applied' && (
        <div className="intervention-actions">
          <button type="button" disabled={busy} onClick={() => void act('cancel')}>
            Cancel hold
          </button>
        </div>
      )}
      {error && <div className="intervention-error">{error}</div>}
    </div>
  );
}
