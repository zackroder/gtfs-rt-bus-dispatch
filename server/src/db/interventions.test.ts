import { describe, expect, it } from 'vitest';
import { createDatabase } from './schema';
import { InterventionConflictError, InterventionStore } from './interventions';

// A compact suggestion fixture exercises durable queue identity and every supported lifecycle path.
function suggestion() {
  return {
    id: 'hold:20260813:T:1:D2',
    serviceDate: '20260813',
    terminalId: 'T',
    routeId: '1',
    rule: 'hold' as const,
    tripId: 'D2',
    vehicleId: 'V2',
    holdSeconds: 90,
    reason: 'uneven headways',
    until: 900,
    generatedAt: 100,
    expiresAt: 200,
  };
}

describe('InterventionStore', () => {
  // Tests inspect both current state and append-only audit rows because they commit together.
  it('persists a pending suggestion and append-only creation/view events', () => {
    const db = createDatabase(':memory:');
    const store = new InterventionStore(db);
    const created = store.createSuggestion(suggestion());
    expect(created.status).toBe('pending');
    expect(store.createSuggestion(suggestion()).id).toBe(created.id);

    store.view(created.id, { actorId: 'manager-1', requestId: 'view-1' }, 110);
    const events = db
      .prepare(`SELECT action, actor_id FROM intervention_events WHERE intervention_id = ? ORDER BY id`)
      .all(created.id) as Array<{ action: string; actor_id: string }>;
    expect(events).toEqual([
      { action: 'created', actor_id: 'system' },
      { action: 'viewed', actor_id: 'manager-1' },
    ]);
  });

  it('supports approval, cancellation, and conflict protection', () => {
    const db = createDatabase(':memory:');
    const store = new InterventionStore(db);
    const created = store.createSuggestion(suggestion());
    expect(store.apply(created.id, { actorId: 'manager-1' }, 120).status).toBe('applied');
    expect(store.cancel(created.id, { actorId: 'manager-1' }, 130).status).toBe('canceled');
    expect(() => store.decline(created.id, { actorId: 'manager-1' }, 140)).toThrow(InterventionConflictError);
  });

  it('expires pending suggestions and completes approved trips', () => {
    const db = createDatabase(':memory:');
    const store = new InterventionStore(db);
    const pending = store.createSuggestion(suggestion());
    store.expirePending('20260813', 200);
    expect(store.require(pending.id).status).toBe('expired');

    const applied = store.createSuggestion({ ...suggestion(), id: 'hold:20260813:T:1:D3', tripId: 'D3' });
    store.apply(applied.id, { actorId: 'manager-1' }, 120);
    store.completeTrip('20260813', 'D3', 150);
    expect(store.require(applied.id).status).toBe('completed');
  });
});
