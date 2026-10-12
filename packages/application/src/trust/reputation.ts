import { computeReputation, type ReputationInputs, type ReputationTier } from '@thrift/domain';
import { many, one, withTransaction, type Queryable } from '@thrift/database';
import type { AppContext } from '../core/context';

/**
 * Reputation inputs come only from completed service: delivered orders that were not fully refunded, published
 * reviews, dispatch timeliness, seller cancellations and upheld disputes. Paid promotion and identity verification
 * are deliberately NOT inputs.
 */
export async function reputationInputs(db: Queryable, shopId: string): Promise<ReputationInputs> {
  const r = await one<{
    completed: number; review_count: number; rating_sum: number; on_time: number; measured: number; cancellations: number; upheld: number;
  }>(
    db,
    `SELECT
       (SELECT count(*) FROM orders o WHERE o.shop_id = $1 AND o.status IN ('confirmed','completed')
          AND (o.fulfilment_status = 'delivered' OR o.buyer_confirmed_at IS NOT NULL) AND o.payment_status <> 'refunded')::int AS completed,
       (SELECT count(*) FROM reviews rv WHERE rv.shop_id = $1 AND rv.status = 'published')::int AS review_count,
       (SELECT coalesce(sum(rv.rating_overall), 0) FROM reviews rv WHERE rv.shop_id = $1 AND rv.status = 'published')::int AS rating_sum,
       (SELECT count(*) FROM orders o JOIN shipments sh ON sh.order_id = o.id
         WHERE o.shop_id = $1 AND o.dispatched_at IS NOT NULL AND sh.dispatch_by IS NOT NULL AND o.dispatched_at <= sh.dispatch_by)::int AS on_time,
       (SELECT count(*) FROM orders o JOIN shipments sh ON sh.order_id = o.id
         WHERE o.shop_id = $1 AND sh.dispatch_by IS NOT NULL AND (o.dispatched_at IS NOT NULL OR (sh.dispatch_by < now() AND o.status = 'confirmed')))::int AS measured,
       (SELECT count(*) FROM order_events e JOIN orders o ON o.id = e.order_id WHERE o.shop_id = $1 AND e.kind = 'seller_cancelled')::int AS cancellations,
       (SELECT count(*) FROM disputes d JOIN orders o ON o.id = d.order_id
         WHERE o.shop_id = $1 AND d.status = 'resolved' AND d.outcome IN ('full_refund','partial_refund','return_and_refund'))::int AS upheld`,
    [shopId],
  );
  return {
    completedOrders: r.completed,
    reviewCount: r.review_count,
    ratingSum: r.rating_sum,
    onTimeDispatches: r.on_time,
    dispatchesMeasured: r.measured,
    sellerCancellations: r.cancellations,
    upheldDisputes: r.upheld,
  };
}

/** Recomputes a shop's reputation, writes a snapshot and the denormalised shop fields used for display. */
export async function refreshShopReputation(db: Queryable, shopId: string): Promise<{ tier: ReputationTier; score: number | null }> {
  const inputs = await reputationInputs(db, shopId);
  const result = computeReputation(inputs);
  const onTimeRate = inputs.dispatchesMeasured > 0 ? Math.round((inputs.onTimeDispatches / inputs.dispatchesMeasured) * 10_000) / 10_000 : null;
  await db.query(
    `INSERT INTO reputation_snapshots (shop_id, completed_orders, review_count, rating_avg, on_time_dispatch_rate, seller_cancellations, upheld_disputes, score, tier, inputs)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [shopId, inputs.completedOrders, inputs.reviewCount, result.ratingAvg, onTimeRate, inputs.sellerCancellations, inputs.upheldDisputes, result.score, result.tier, JSON.stringify(inputs)],
  );
  await db.query(
    `UPDATE shops SET completed_orders = $2, review_count = $3, rating_avg = $4, reputation_tier = $5, updated_at = now() WHERE id = $1`,
    [shopId, inputs.completedOrders, inputs.reviewCount, result.ratingAvg, result.tier],
  );
  return { tier: result.tier, score: result.score };
}

/** Worker: refreshes shops with recent activity (and any never computed). Rebuildable at any time. */
export async function refreshReputations(ctx: AppContext, batchSize = 200): Promise<{ refreshed: number }> {
  const shops = await many<{ id: string }>(
    ctx.pool,
    `SELECT s.id FROM shops s
      WHERE s.status IN ('active','paused','suspended')
        AND (NOT EXISTS (SELECT 1 FROM reputation_snapshots r WHERE r.shop_id = s.id)
             OR EXISTS (SELECT 1 FROM orders o WHERE o.shop_id = s.id AND o.updated_at > coalesce((SELECT max(computed_at) FROM reputation_snapshots r WHERE r.shop_id = s.id), '-infinity'))
             OR EXISTS (SELECT 1 FROM reviews rv WHERE rv.shop_id = s.id AND rv.updated_at > coalesce((SELECT max(computed_at) FROM reputation_snapshots r WHERE r.shop_id = s.id), '-infinity')))
      LIMIT $1`,
    [batchSize],
  );
  for (const s of shops) await withTransaction(ctx.pool, (tx) => refreshShopReputation(tx, s.id));
  return { refreshed: shops.length };
}
