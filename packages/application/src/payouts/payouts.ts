import { addHours, assertTransition, formatNaira, PAYOUT_STATUS, type PayoutStatus } from '@thrift/domain';
import { many, maybeOne, one, withTransaction, type Queryable } from '@thrift/database';
import type { AppContext } from '../core/context';
import { getSettings } from '../core/settings';
import { postLedgerTransaction } from '../ledger/ledger';
import { notifyUser } from '../notifications/notify';

interface PayoutState {
  id: string;
  status: PayoutStatus;
  amount_minor: number;
  shop_id: string;
  order_id: string;
  eligible_at: Date | null;
  hold_reason: string | null;
  payment_status: string;
  dispute_status: string;
  order_status: string;
  shipment_status: string | null;
  confidence: string | null;
  delivered_at: Date | null;
  buyer_confirmed_at: Date | null;
  [k: string]: unknown;
}

/**
 * Re-evaluates one order's payout inside the caller's transaction (locks the payout row).
 * Rules (decision D06 drafts, configurable):
 *   - an open dispute blocks the payout; resolution returns it to held and it is re-evaluated;
 *   - eligible only when the payment is confirmed AND delivery is buyer-confirmed, courier-verified (after a delay)
 *     or staff-verified. Seller-reported delivery alone NEVER makes a payout eligible.
 */
export async function refreshPayoutForOrder(tx: Queryable, ctx: AppContext, orderId: string): Promise<PayoutStatus | null> {
  const p = await maybeOne<PayoutState>(
    tx,
    `SELECT po.id, po.status, po.amount_minor, po.shop_id, po.order_id, po.eligible_at, po.hold_reason,
            o.payment_status, o.dispute_status, o.status AS order_status, o.buyer_confirmed_at,
            sh.status AS shipment_status, sh.confidence, sh.delivered_at
       FROM payouts po JOIN orders o ON o.id = po.order_id LEFT JOIN shipments sh ON sh.order_id = po.order_id
      WHERE po.order_id = $1 FOR UPDATE OF po`,
    [orderId],
  );
  if (!p) return null;
  if (!['held', 'blocked', 'eligible'].includes(p.status)) return p.status;
  const settings = await getSettings(tx);
  let next: PayoutStatus = p.status;
  let eligibleAt: Date | null = p.eligible_at;
  let reason: string | null = null;
  if (p.dispute_status === 'open') {
    next = 'blocked';
    reason = 'dispute_open';
  } else if (p.payment_status !== 'paid' || p.order_status === 'cancelled') {
    next = p.status === 'blocked' ? 'held' : p.status === 'eligible' ? 'held' : p.status;
    reason = 'payment_not_settled';
  } else {
    const delivered = p.shipment_status === 'delivered' || p.buyer_confirmed_at !== null;
    if (delivered && (p.confidence === 'buyer_confirmed' || p.buyer_confirmed_at !== null)) {
      next = 'eligible';
      eligibleAt = addHours(new Date(p.buyer_confirmed_at ?? p.delivered_at ?? ctx.now()), settings.payout_release_hours_after_confirmation);
    } else if (delivered && p.confidence === 'staff_verified') {
      next = 'eligible';
      eligibleAt = new Date(p.delivered_at ?? ctx.now());
    } else if (delivered && p.confidence === 'courier_verified') {
      next = 'eligible';
      eligibleAt = addHours(new Date(p.delivered_at ?? ctx.now()), settings.payout_release_hours_after_courier_delivery);
    } else {
      next = 'held';
      reason = p.shipment_status === 'delivered' ? 'awaiting_buyer_confirmation' : 'awaiting_delivery';
    }
  }
  const nextReason = next === 'eligible' ? null : reason;
  const unchanged = next === 'eligible' ? eligibleAt?.getTime() === p.eligible_at?.getTime() : nextReason === p.hold_reason;
  if (next === p.status && unchanged) return p.status;
  if (next !== p.status) assertTransition(PAYOUT_STATUS, p.status, next, 'payout');
  await tx.query(
    `UPDATE payouts SET status = $2, eligible_at = $3, hold_reason = $4, updated_at = now() WHERE id = $1`,
    [p.id, next, next === 'eligible' ? eligibleAt : null, nextReason],
  );
  await tx.query(`UPDATE orders SET payout_status = $2, updated_at = now() WHERE id = $1`, [orderId, next]);
  return next;
}

/** Worker: periodic re-evaluation (backstop for missed events). */
export async function evaluatePayouts(ctx: AppContext, batchSize = 100): Promise<{ checked: number }> {
  const rows = await many<{ order_id: string }>(
    ctx.pool,
    `SELECT order_id FROM payouts WHERE status IN ('held','blocked') ORDER BY updated_at LIMIT $1`,
    [batchSize],
  );
  for (const r of rows) {
    await withTransaction(ctx.pool, async (tx) => {
      await tx.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [r.order_id]);
      await refreshPayoutForOrder(tx, ctx, r.order_id);
    });
  }
  return { checked: rows.length };
}

/**
 * Worker: releases eligible payouts whose time has come to shops with a verified payout account past its
 * cooling-off period. Claim (processing) → provider transfer outside the transaction → apply result.
 * Transfers carry a stable reference so a retried transfer cannot pay twice at the provider.
 */
export async function releasePayouts(ctx: AppContext, batchSize = 20): Promise<{ paid: number; failed: number; skipped: number }> {
  const claimed = await withTransaction(ctx.pool, (tx) =>
    many<{ id: string; order_id: string; shop_id: string; amount_minor: number; recipient: string | null; account_id: string | null }>(
      tx,
      `UPDATE payouts po SET status = 'processing', processing_started_at = now(), attempts = po.attempts + 1,
              payout_account_id = pa.id, updated_at = now()
         FROM payout_accounts pa
        WHERE pa.shop_id = po.shop_id AND pa.status = 'verified' AND pa.usable_after <= now()
          AND po.id IN (
            SELECT id FROM payouts
             WHERE (status = 'eligible' AND eligible_at <= now())
                OR (status = 'failed' AND attempts < 5 AND updated_at < now() - interval '30 minutes')
                OR (status = 'processing' AND processing_started_at < now() - interval '10 minutes')
             ORDER BY eligible_at NULLS LAST LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING po.id, po.order_id, po.shop_id, po.amount_minor, pa.provider_recipient_code AS recipient, pa.id AS account_id`,
      [batchSize],
    ),
  );
  let paid = 0;
  let failed = 0;
  let skipped = 0;
  for (const p of claimed) {
    if (p.amount_minor === 0) {
      skipped++;
      await finishPayout(ctx, p, 'succeeded', null);
      continue;
    }
    let res: { status: 'processing' | 'succeeded' | 'failed'; providerReference: string | null };
    try {
      res = await ctx.providers.payments.transfer({
        recipientCode: p.recipient ?? `sandbox-${p.shop_id}`,
        amountMinor: p.amount_minor,
        reference: `PO-${p.id}`,
        reason: 'Thrift Market payout',
      });
    } catch (err) {
      res = { status: 'failed', providerReference: null };
      await ctx.pool.query(`UPDATE payouts SET last_error = $2 WHERE id = $1`, [p.id, String((err as Error).message).slice(0, 500)]);
    }
    if (res.status === 'processing') continue;
    await finishPayout(ctx, p, res.status, res.providerReference);
    if (res.status === 'succeeded') paid++;
    else failed++;
  }
  return { paid, failed, skipped };
}

async function finishPayout(
  ctx: AppContext,
  p: { id: string; order_id: string; shop_id: string; amount_minor: number },
  status: 'succeeded' | 'failed',
  providerReference: string | null,
): Promise<void> {
  await withTransaction(ctx.pool, async (tx) => {
    await tx.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [p.order_id]);
    const cur = await one<{ status: PayoutStatus; amount_minor: number }>(tx, 'SELECT status, amount_minor FROM payouts WHERE id = $1 FOR UPDATE', [p.id]);
    if (cur.status !== 'processing') return;
    if (status === 'failed') {
      await tx.query(`UPDATE payouts SET status = 'failed', updated_at = now() WHERE id = $1`, [p.id]);
      return;
    }
    if (cur.amount_minor > 0) {
      await postLedgerTransaction(tx, {
        kind: 'payout_released',
        orderId: p.order_id,
        description: 'Seller payout released',
        idempotencyKey: `payout:${p.id}`,
        lines: [
          { account: 'seller_payable', amountMinor: cur.amount_minor, shopId: p.shop_id },
          { account: 'provider_clearing', amountMinor: -cur.amount_minor },
        ],
      });
    }
    await tx.query(`UPDATE payouts SET status = 'paid', released_at = now(), provider_reference = $2, updated_at = now() WHERE id = $1`, [p.id, providerReference]);
    await tx.query(
      `UPDATE orders SET payout_status = 'released', status = CASE WHEN status = 'confirmed' THEN 'completed' ELSE status END,
              completed_at = CASE WHEN status = 'confirmed' THEN now() ELSE completed_at END, updated_at = now() WHERE id = $1`,
      [p.order_id],
    );
    await tx.query(`INSERT INTO order_events (order_id, kind, actor_kind, data) VALUES ($1, 'payout_released', 'system', $2)`, [
      p.order_id,
      JSON.stringify({ payoutId: p.id, amountMinor: cur.amount_minor }),
    ]);
    const owner = await one<{ owner_user_id: string; number: string }>(
      tx,
      'SELECT s.owner_user_id, o.number FROM orders o JOIN shops s ON s.id = o.shop_id WHERE o.id = $1',
      [p.order_id],
    );
    await notifyUser(tx, {
      userId: owner.owner_user_id,
      topic: 'transactional',
      kind: 'payout_released',
      title: `Payout of ${formatNaira(cur.amount_minor)} released for order ${owner.number}`,
      link: '/sell/payouts',
      dedupeKey: `payout-released:${p.id}`,
    });
  });
}
