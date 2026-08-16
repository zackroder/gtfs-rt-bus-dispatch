import type { Database } from 'better-sqlite3';
import type {
  Intervention,
  InterventionAction,
  InterventionStatus,
} from '../../../shared/types';

// InterventionStore is the durable lifecycle boundary for recommendations. State changes and
// their audit events are committed together so a UI action cannot be recorded without its outcome.
export interface InterventionSuggestionInput {
  id: string;
  serviceDate: string;
  terminalId: string;
  routeId: string;
  rule: 'hold';
  tripId: string;
  vehicleId?: string;
  leaderVehicleId?: string;
  followerVehicleId?: string;
  holdSeconds: number;
  reason: string;
  until: number;
  generatedAt: number;
  expiresAt: number;
}

export interface InterventionActor {
  actorId?: string;
  requestId?: string;
}

interface InterventionRow {
  id: string;
  service_date: string;
  terminal_id: string;
  route_id: string;
  rule: 'hold';
  trip_id: string;
  vehicle_id: string | null;
  leader_vehicle_id: string | null;
  follower_vehicle_id: string | null;
  hold_seconds: number;
  reason: string;
  until_seconds: number | null;
  generated_at: number;
  expires_at: number | null;
  status: InterventionStatus;
  applied_at: number | null;
  resolved_at: number | null;
}

export class InterventionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InterventionConflictError';
  }
}

// Persist recommendations, enforce legal transitions, and append their audit history.
export class InterventionStore {
  constructor(private db: Database) {}

  // Insert a recommendation once and return the durable row, even when refresh repeats it.
  createSuggestion(input: InterventionSuggestionInput): Intervention {
    const transaction = this.db.transaction(() => {
      // The unique schedule key makes repeated refreshes idempotent for the same recommendation.
      const result = this.db
        .prepare(
          `INSERT INTO interventions (
             id, service_date, terminal_id, route_id, rule, trip_id, vehicle_id,
             leader_vehicle_id, follower_vehicle_id, hold_seconds, reason,
             until_seconds, generated_at, expires_at, status
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
           ON CONFLICT(service_date, terminal_id, route_id, trip_id, rule) DO NOTHING`,
        )
        .run(
          input.id,
          input.serviceDate,
          input.terminalId,
          input.routeId,
          input.rule,
          input.tripId,
          input.vehicleId ?? null,
          input.leaderVehicleId ?? null,
          input.followerVehicleId ?? null,
          input.holdSeconds,
          input.reason,
          input.until,
          input.generatedAt,
          input.expiresAt,
        );
      if (result.changes > 0) {
        // Only the refresh that actually inserted the row emits the creation event.
        this.insertEvent(input.id, 'created', input.generatedAt, 'system');
      }
    });
    transaction();
    return this.require(input.id);
  }

  // List all recommendations for a terminal within one service date.
  listForTerminal(serviceDate: string, terminalId: string): Intervention[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM interventions
         WHERE service_date = ? AND terminal_id = ?
         ORDER BY generated_at DESC, id`,
      )
      .all(serviceDate, terminalId) as InterventionRow[];
    return rows.map(toIntervention);
  }

  // List the complete queue for one service date.
  listForServiceDate(serviceDate: string): Intervention[] {
    const rows = this.db
      .prepare(`SELECT * FROM interventions WHERE service_date = ? ORDER BY generated_at DESC, id`)
      .all(serviceDate) as InterventionRow[];
    return rows.map(toIntervention);
  }

  // List a route's queue for a terminal and service date.
  listForRoute(serviceDate: string, terminalId: string, routeId: string): Intervention[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM interventions
         WHERE service_date = ? AND terminal_id = ? AND route_id = ?
         ORDER BY generated_at DESC, id`,
      )
      .all(serviceDate, terminalId, routeId) as InterventionRow[];
    return rows.map(toIntervention);
  }

  // Return only holds currently applied to runs on a service date.
  listApplied(serviceDate: string): Intervention[] {
    const rows = this.db
      .prepare(`SELECT * FROM interventions WHERE service_date = ? AND status = 'applied'`)
      .all(serviceDate) as InterventionRow[];
    return rows.map(toIntervention);
  }

  // Read one intervention or raise the domain-specific conflict error for an unknown ID.
  require(id: string): Intervention {
    const row = this.db.prepare(`SELECT * FROM interventions WHERE id = ?`).get(id) as
      | InterventionRow
      | undefined;
    if (!row) throw new InterventionConflictError(`unknown intervention ${id}`);
    return toIntervention(row);
  }

  // Record that an operator opened a recommendation without changing its lifecycle state.
  view(id: string, actor: InterventionActor, now: number): Intervention {
    const intervention = this.require(id);
    this.insertEvent(id, 'viewed', now, actor.actorId ?? 'anonymous', actor.requestId);
    return intervention;
  }

  // Approve a pending recommendation, or make an already-applied retry idempotent.
  apply(id: string, actor: InterventionActor, now: number): Intervention {
    return this.transition(id, 'applied', ['pending', 'applied'], actor, now);
  }

  // Decline a pending recommendation, with the same conflict protection as other transitions.
  decline(id: string, actor: InterventionActor, now: number): Intervention {
    return this.transition(id, 'declined', ['pending', 'declined'], actor, now);
  }

  // Cancel a pending/applied recommendation when an operator or reload invalidates it.
  cancel(id: string, actor: InterventionActor, now: number): Intervention {
    return this.transition(id, 'canceled', ['pending', 'applied', 'canceled'], actor, now);
  }

  // Expire pending recommendations whose wall-clock deadline has passed.
  expirePending(serviceDate: string, now: number): void {
    const transaction = this.db.transaction(() => {
      // Expiration is service-date scoped so a stale overnight queue cannot affect another day.
      const rows = this.db
        .prepare(
          `SELECT id FROM interventions
           WHERE service_date = ? AND status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`,
        )
        .all(serviceDate, now) as Array<{ id: string }>;
      for (const row of rows) {
        this.db
          .prepare(`UPDATE interventions SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'`)
          .run(now, row.id);
        this.insertEvent(row.id, 'expired', now, 'system');
      }
    });
    transaction();
  }

  // Resolve recommendations when their associated trip is observed to have completed.
  completeTrip(serviceDate: string, tripId: string, now: number): void {
    const transaction = this.db.transaction(() => {
      // A completed trip resolves pending suggestions as expired but marks an applied hold completed.
      const rows = this.db
        .prepare(
          `SELECT id, status FROM interventions
           WHERE service_date = ? AND trip_id = ? AND status IN ('pending', 'applied')`,
        )
        .all(serviceDate, tripId) as Array<{ id: string; status: InterventionStatus }>;
      for (const row of rows) {
        const action: InterventionAction = row.status === 'applied' ? 'completed' : 'expired';
        this.db
          .prepare(`UPDATE interventions SET status = ?, resolved_at = ? WHERE id = ?`)
          .run(action, now, row.id);
        this.insertEvent(row.id, action, now, 'system');
      }
    });
    transaction();
  }

  // Cancel unresolved recommendations before replacing the static schedule.
  cancelForStaticReload(now: number): void {
    const transaction = this.db.transaction(() => {
      // Schedule identities may change after reload, so unresolved recommendations are unsafe to keep.
      const rows = this.db
        .prepare(`SELECT id FROM interventions WHERE status IN ('pending', 'applied')`)
        .all() as Array<{ id: string }>;
      for (const row of rows) {
        this.db
          .prepare(`UPDATE interventions SET status = 'canceled', resolved_at = ? WHERE id = ?`)
          .run(now, row.id);
        this.insertEvent(row.id, 'canceled', now, 'system');
      }
    });
    transaction();
  }

  private transition(
    id: string,
    target: InterventionStatus,
    allowed: InterventionStatus[],
    actor: InterventionActor,
    now: number,
  ): Intervention {
    // Check expiry before entering the state transition transaction so a manager cannot approve
    // an already stale recommendation; the transaction then re-reads the row for conflict safety.
    const currentBeforeTransaction = this.require(id);
    if (
      currentBeforeTransaction.status === 'pending' &&
      currentBeforeTransaction.expiresAt !== undefined &&
      currentBeforeTransaction.expiresAt <= now
    ) {
      this.expirePending(currentBeforeTransaction.serviceDate, now);
      throw new InterventionConflictError(`intervention ${id} has expired`);
    }
    const transaction = this.db.transaction(() => {
      const current = this.require(id);
      if (!allowed.includes(current.status)) {
        throw new InterventionConflictError(
          `cannot ${target} intervention ${id} from ${current.status}`,
        );
      }
      if (current.status === target) {
        // Repeated idempotent commands return the same state but still preserve an audit attempt.
        this.insertEvent(id, target as InterventionAction, now, actor.actorId ?? 'anonymous', actor.requestId);
        return;
      }
      const appliedAt = target === 'applied' ? now : current.appliedAt ?? null;
      const resolvedAt = ['declined', 'canceled', 'expired', 'completed'].includes(target)
        ? now
        : null;
      this.db
        .prepare(
          `UPDATE interventions
           SET status = ?, applied_at = ?, resolved_at = ?
           WHERE id = ? AND status = ?`,
        )
        .run(target, appliedAt, resolvedAt, id, current.status);
      this.insertEvent(id, target as InterventionAction, now, actor.actorId ?? 'anonymous', actor.requestId);
    });
    transaction();
    return this.require(id);
  }

  private insertEvent(
    interventionId: string,
    action: InterventionAction,
    occurredAt: number,
    actorId: string,
    requestId?: string,
  ): void {
    // request_id makes retried API requests append at most one event for the same action.
    this.db
      .prepare(
        `INSERT OR IGNORE INTO intervention_events
         (intervention_id, action, occurred_at, actor_id, request_id)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(interventionId, action, occurredAt, actorId, requestId ?? null);
  }
}

function toIntervention(row: InterventionRow): Intervention {
  // Convert SQLite nulls back to the optional wire shape used by the web client.
  return {
    id: row.id,
    serviceDate: row.service_date,
    terminalId: row.terminal_id,
    routeId: row.route_id,
    rule: row.rule,
    tripId: row.trip_id,
    vehicleId: row.vehicle_id ?? undefined,
    leaderVehicleId: row.leader_vehicle_id ?? undefined,
    followerVehicleId: row.follower_vehicle_id ?? undefined,
    holdSeconds: row.hold_seconds,
    reason: row.reason,
    until: row.until_seconds ?? undefined,
    generatedAt: row.generated_at,
    expiresAt: row.expires_at ?? undefined,
    status: row.status,
    appliedAt: row.applied_at ?? undefined,
    resolvedAt: row.resolved_at ?? undefined,
  };
}
