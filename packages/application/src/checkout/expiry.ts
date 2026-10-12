import { many, maybeOne, withTransaction } from '@thrift/database';
import type { AppContext } from '../core/context';
import { getSettings } from '../core/settings';
import { markReservationPaymentPending, releaseReservation } from '../inventory/authority';
import { applyVerifiedPayment } from '../payments/apply';
import { enqueueReservationReleased, liveGroupFor } from './holds';

export { enqueueReservationReleased } from './holds';

/**
 * Releases a hold and, when it belongs to an unpaid order, every other hold in that order too (a checkout group
 * expires as a unit, never one piece at a time), then cancels the order.
 */
async function releaseAndCancel(ctx: AppContext, reservationId: string, reason: string): Promise<boolean> {
  return withTransaction(ctx.pool, async (tx) => {
    const group = await liveGroupFor(tx, reservationId);
    let released = false;
    for (const id of group.reservationIds) {
      const rel = await releaseReservation(tx, id, { reason, status: 'expired' });
      if (!rel.released) continue;
      released = true;
      await enqueueReservationReleased(tx, id);
    }
    if (!released) return false;
    const orders = await many<{ id: string }>(
      tx,
      `UPDATE orders SET status = 'cancelled', payment_status = CASE WHEN payment_status = 'pending' THEN 'failed' ELSE payment_status END,
              fulfilment_status = 'cancelled', cancel_reason = 'hold_expired_unpaid', cancelled_at = now(), updated_at = now()
        WHERE id = ANY($1::uuid[]) AND status = 'pending_payment' RETURNING id`,
      [group.orderIds],
    );
    for (const o of orders) {
      // Attempts the provider reported as definitively failed are closed; unknown ones stay uncertain so a late
      // success is caught by reconciliation and refunded (or re-allocated if the units are still free).
      await tx.query(`UPDATE payment_attempts SET status = 'abandoned', updated_at = now() WHERE order_id = $1 AND status = 'initiated'`, [o.id]);
      await tx.query(`INSERT INTO order_events (order_id, kind, actor_kind, data) VALUES ($1, 'hold_expired', 'system', $2)`, [
        o.id,
        JSON.stringify({ reservationIds: group.reservationIds }),
      ]);
    }
    return true;
  });
}

type Verdict = 'paid' | 'failed' | 'pending';

/** Verifies every unresolved attempt of the reservation's live order with the provider (outside transactions). */
async function verifyReservationPayments(ctx: AppContext, reservationId: string): Promise<Verdict> {
  const attempts = await many<{ reference: string }>(
    ctx.pool,
    `SELECT DISTINCT pa.reference FROM payment_attempts pa JOIN orders o ON o.id = pa.order_id JOIN order_items oi ON oi.order_id = o.id
      WHERE oi.reservation_id = $1 AND o.status = 'pending_payment' AND pa.status IN ('initiated','pending','uncertain')`,
    [reservationId],
  );
  let pending = false;
  for (const a of attempts) {
    const r = await applyVerifiedPayment(ctx, a.reference);
    if (r.outcome === 'paid' || r.outcome === 'late_reallocated' || r.outcome === 'already_applied') return 'paid';
    if (r.outcome === 'pending' || r.outcome === 'mismatch') pending = true;
  }
  return pending ? 'pending' : 'failed';
}

/**
 * Worker: handles holds past their expiry. A local timer is never enough to free stock: unresolved payments are
 * verified with the provider first. Definitely unpaid → release + cancel. Unknown → payment_pending with a grace
 * period; still unknown after grace → release, and any late success later takes the refund/re-allocation path.
 */
export async function expireReservations(ctx: AppContext, batchSize = 50): Promise<{ released: number; paid: number; graced: number }> {
  const settings = await getSettings(ctx.pool);
  const due = await many<{ id: string; status: string }>(
    ctx.pool,
    `SELECT id, status FROM reservations
      WHERE (status = 'active' AND expires_at <= $1) OR (status = 'payment_pending' AND grace_until <= $1)
      ORDER BY expires_at LIMIT $2`,
    [ctx.now(), batchSize],
  );
  let released = 0;
  let paid = 0;
  let graced = 0;
  for (const r of due) {
    // Cheap per-row claim: skip rows another worker is handling right now.
    const claimed = await withTransaction(ctx.pool, async (tx) =>
      maybeOne<{ id: string }>(tx, `SELECT id FROM reservations WHERE id = $1 AND status IN ('active','payment_pending') FOR UPDATE SKIP LOCKED`, [r.id]),
    );
    if (!claimed) continue;
    const verdict = await verifyReservationPayments(ctx, r.id);
    if (verdict === 'paid') {
      paid++;
      continue;
    }
    if (verdict === 'pending' && r.status === 'active') {
      const graceUntil = new Date(ctx.now().getTime() + settings.payment_grace_minutes * 60_000);
      await withTransaction(ctx.pool, async (tx) => {
        // The whole group waits for the payment outcome together.
        for (const id of (await liveGroupFor(tx, r.id)).reservationIds) await markReservationPaymentPending(tx, id, graceUntil);
      });
      graced++;
      continue;
    }
    if (await releaseAndCancel(ctx, r.id, verdict === 'pending' ? 'payment_unresolved_after_grace' : 'hold_expired')) released++;
  }
  return { released, paid, graced };
}

/** Worker: verifies payment attempts whose outcome is unknown (missed webhooks, failed initialisation). */
export async function reconcilePaymentAttempts(ctx: AppContext, batchSize = 50): Promise<{ checked: number }> {
  const rows = await many<{ reference: string }>(
    ctx.pool,
    `SELECT reference FROM payment_attempts
      WHERE status IN ('initiated','pending','uncertain') AND created_at < now() - interval '2 minutes'
        AND (last_verified_at IS NULL OR last_verified_at < now() - interval '2 minutes')
        AND created_at > now() - interval '30 days'
      ORDER BY coalesce(last_verified_at, created_at) LIMIT $1`,
    [batchSize],
  );
  for (const r of rows) await applyVerifiedPayment(ctx, r.reference);
  return { checked: rows.length };
}
