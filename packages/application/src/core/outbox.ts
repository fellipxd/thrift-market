import type { Queryable } from '@thrift/database';

export interface OutboxInput {
  topic: string;
  aggregateId?: string | null;
  payload?: Record<string, unknown>;
  /** Unique key: a duplicate enqueue becomes a no-op (deduplicated side effects). */
  dedupeKey?: string | null;
  availableAt?: Date;
}

/**
 * Durable outbox. Enqueue inside the same transaction as the state change; the worker dispatches
 * events to registered handlers with retries and dead-lettering.
 */
export async function enqueue(db: Queryable, input: OutboxInput): Promise<void> {
  await db.query(
    `INSERT INTO outbox_events (topic, aggregate_id, payload, dedupe_key, available_at)
     VALUES ($1, $2, $3, $4, coalesce($5, now()))
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [input.topic, input.aggregateId ?? null, JSON.stringify(input.payload ?? {}), input.dedupeKey ?? null, input.availableAt ?? null],
  );
}
