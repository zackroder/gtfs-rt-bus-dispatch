import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

  it('refuses to apply a suggestion whose window already passed', () => {
    // A degenerate engine decision (until at/before creation) expires at generatedAt; the
    // apply gate must reject it rather than let it lock an impossible hold into the ledger.
    const db = createDatabase(':memory:');
    const store = new InterventionStore(db);
    const stale = store.createSuggestion({ ...suggestion(), expiresAt: 100 });
    expect(() => store.apply(stale.id, { actorId: 'manager-1' }, 100)).toThrow(
      InterventionConflictError,
    );
    expect(store.require(stale.id).status).toBe('expired');
  });

  it('revises a pending suggestion in place and audits the update', () => {
    const db = createDatabase(':memory:');
    const store = new InterventionStore(db);
    const created = store.createSuggestion(suggestion());

    // Unchanged values are a no-op with no audit noise.
    expect(store.refreshSuggestion(suggestion())).toBe('unchanged');
    // A >= 30s move of the departure target is a material revision.
    expect(store.refreshSuggestion({ ...suggestion(), until: 930, expiresAt: 260 })).toBe('updated');
    const revised = store.require(created.id);
    expect(revised.until).toBe(930);
    expect(revised.expiresAt).toBe(260);
    // Small jitter below the 30-second hysteresis does not revise the row.
    expect(store.refreshSuggestion({ ...suggestion(), until: 945, expiresAt: 260 })).toBe('unchanged');
    expect(store.require(created.id).until).toBe(930);

    const events = db
      .prepare(`SELECT action FROM intervention_events WHERE intervention_id = ? ORDER BY id`)
      .all(created.id) as Array<{ action: string }>;
    expect(events.map((e) => e.action)).toEqual(['created', 'updated']);
  });

  it('never revises a suggestion once it left the pending state', () => {
    const db = createDatabase(':memory:');
    const store = new InterventionStore(db);
    const created = store.createSuggestion(suggestion());
    store.apply(created.id, { actorId: 'manager-1' }, 120);
    expect(store.refreshSuggestion({ ...suggestion(), until: 1200 })).toBe('skipped');
    expect(store.require(created.id).until).toBe(900);
  });

  it('migrates an intervention_events table whose CHECK predates the updated action', () => {
    // Old databases carry a CHECK constraint without 'updated'; inserts of the new action
    // must succeed after createDatabase rebuilds the table, with every audit row preserved.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-schema-'));
    const dbPath = path.join(dir, 'legacy.db');
    try {
      const legacy = createDatabase(dbPath);
      legacy.exec(`
        DROP TABLE intervention_events;
        CREATE TABLE intervention_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          intervention_id TEXT NOT NULL REFERENCES interventions(id),
          action TEXT NOT NULL CHECK (action IN ('created', 'viewed', 'applied', 'declined', 'canceled', 'expired', 'completed')),
          occurred_at INTEGER NOT NULL,
          actor_id TEXT NOT NULL,
          request_id TEXT,
          metadata_json TEXT
        );
      `);
      const store = new InterventionStore(legacy);
      store.createSuggestion(suggestion());
      legacy.close();

      const migrated = createDatabase(dbPath);
      const reopened = new InterventionStore(migrated);
      const row = reopened.refreshSuggestion({ ...suggestion(), until: 930, expiresAt: 260 });
      expect(row).toBe('updated');
      const events = migrated
        .prepare(`SELECT action FROM intervention_events WHERE intervention_id = ? ORDER BY id`)
        .all(suggestion().id) as Array<{ action: string }>;
      expect(events.map((e) => e.action)).toEqual(['created', 'updated']);
      migrated.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
