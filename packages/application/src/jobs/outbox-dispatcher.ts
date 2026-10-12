import { many, withTransaction, type Queryable } from '@thrift/database';
import type { AppContext } from '../core/context';

export type OutboxHandler = (ctx: AppContext, event: { id: number; topic: string; aggregateId: string | null; payload: Record<string, unknown> }, tx: Queryable) => Promise<void>;

const handlers = new Map<string, OutboxHandler[]>();

/**
 * Registers a handler for an outbox topic. Handlers must be idempotent (events may be retried).
 * Several modules may subscribe to the same topic (e.g. `order.paid` is consumed by messaging, offers
 * and auctions); all of them run, in registration order, inside the event's transaction. Registering
 * the same function twice for a topic is a no-op.
 */
export function registerOutboxHandler(topic: string, handler: OutboxHandler): void {
  const list = handlers.get(topic) ?? [];
  if (!list.includes(handler)) list.push(handler);
  handlers.set(topic, list);
}

export function registeredTopics(): string[] {
  return [...handlers.keys()];
}

const MAX_ATTEMPTS = 8;

/**
 * Claims a batch of due outbox events with SKIP LOCKED (safe with several workers), runs each handler in
 * its own transaction, retries with exponential backoff + jitter and dead-letters after MAX_ATTEMPTS.
 * Events with no registered handler are marked done (they are informational).
 */
export async function dispatchOutbox(ctx: AppContext, batchSize = 50): Promise<{ processed: number; failed: number }> {
  const claimed = await withTransaction(ctx.pool, (tx) =>
    many<{ id: number; topic: string; aggregate_id: string | null; payload: Record<string, unknown>; attempts: number }>(
      tx,
      `UPDATE outbox_events SET status = 'processing', locked_until = now() + interval '2 minutes', attempts = attempts + 1
        WHERE id IN (
          SELECT id FROM outbox_events
           WHERE (status = 'pending' AND available_at <= now())
              OR (status = 'processing' AND locked_until < now())
           ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING id, topic, aggregate_id, payload, attempts`,
      [batchSize],
    ),
  );
  let processed = 0;
  let failed = 0;
  for (const ev of claimed) {
    const topicHandlers = handlers.get(ev.topic) ?? [];
    try {
      await withTransaction(ctx.pool, async (tx) => {
        for (const handler of topicHandlers) {
          await handler(ctx, { id: ev.id, topic: ev.topic, aggregateId: ev.aggregate_id, payload: ev.payload }, tx);
        }
        await tx.query(`UPDATE outbox_events SET status = 'done', processed_at = now(), last_error = NULL WHERE id = $1`, [ev.id]);
      });
      processed++;
    } catch (err) {
      failed++;
      const dead = ev.attempts >= MAX_ATTEMPTS;
      const backoffSeconds = Math.min(3600, 2 ** ev.attempts * 5) + Math.floor(Math.random() * 5);
      await ctx.pool.query(
        `UPDATE outbox_events SET status = $2, last_error = $3, available_at = now() + ($4 || ' seconds')::interval, locked_until = NULL WHERE id = $1`,
        [ev.id, dead ? 'dead' : 'pending', String((err as Error).message ?? err).slice(0, 1000), String(backoffSeconds)],
      );
    }
  }
  return { processed, failed };
}
