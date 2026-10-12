import { computeOrderTotals, formatNaira, type DeliveryMethod } from '@thrift/domain';
import { maybeOne, one, withTransaction, type Queryable } from '@thrift/database';
import type { VerifyPaymentResult } from '@thrift/providers';
import { recordAudit } from '../core/audit';
import type { AppContext } from '../core/context';
import { enqueue } from '../core/outbox';
import { convertReservation, lockReservation, lockStock } from '../inventory/authority';
import { postLedgerTransaction, type LedgerLine } from '../ledger/ledger';
import { notifyUser } from '../notifications/notify';
import { findAttemptByReference, type PaymentAttemptRow } from './attempts';
import { createRefund } from './refunds';

export type ApplyOutcome =
  | 'paid'
  | 'already_applied'
  | 'late_reallocated'
  | 'late_refunded'
  | 'duplicate_refunded'
  | 'pending'
  | 'failed'
  | 'mismatch'
  | 'not_found'
  | 'delegated';

export interface ApplyResult {
  outcome: ApplyOutcome;
  orderId: string | null;
}

/** Handlers for non-order payment purposes (e.g. promotions) register here. */
const purposeHandlers = new Map<string, (ctx: AppContext, attempt: PaymentAttemptRow, verified: VerifyPaymentResult) => Promise<ApplyResult>>();
export function registerPaymentPurposeHandler(purpose: string, handler: (ctx: AppContext, attempt: PaymentAttemptRow, verified: VerifyPaymentResult) => Promise<ApplyResult>): void {
  purposeHandlers.set(purpose, handler);
}

interface OrderRow {
  id: string;
  number: string;
  buyer_user_id: string;
  shop_id: string;
  source: string;
  source_id: string | null;
  reservation_id: string | null;
  status: string;
  payment_status: string;
  items_total_minor: number;
  shipping_minor: number;
  buyer_fee_minor: number;
  total_minor: number;
  commission_minor: number;
  delivery_method: DeliveryMethod;
  delivery_terms: { dispatchDays?: number; transitDaysMin?: number; transitDaysMax?: number; feeMinor?: number };
  [k: string]: unknown;
}

/**
 * Verifies a payment with the provider (outside any transaction) and applies the verified result exactly once.
 * Used by webhooks, the checkout return page and reconciliation. Never trusts webhook payloads or redirects.
 */
export async function applyVerifiedPayment(ctx: AppContext, reference: string): Promise<ApplyResult> {
  const attempt = await findAttemptByReference(ctx.pool, reference);
  if (!attempt) return { outcome: 'not_found', orderId: null };
  if (attempt.status === 'succeeded' || attempt.status === 'duplicate') return { outcome: 'already_applied', orderId: attempt.order_id };
  let verified: VerifyPaymentResult;
  try {
    verified = await ctx.providers.payments.verify(reference);
  } catch {
    await ctx.pool.query(`UPDATE payment_attempts SET status = CASE WHEN status = 'initiated' THEN 'uncertain' ELSE status END, last_verified_at = now(), updated_at = now() WHERE id = $1`, [attempt.id]);
    return { outcome: 'pending', orderId: attempt.order_id };
  }
  await ctx.pool.query(`UPDATE payment_attempts SET last_verified_at = now() WHERE id = $1`, [attempt.id]);
  if (attempt.purpose !== 'order') {
    const handler = purposeHandlers.get(attempt.purpose);
    return handler ? handler(ctx, attempt, verified) : { outcome: 'pending', orderId: null };
  }
  if (verified.status === 'pending' || verified.status === 'not_found') return { outcome: 'pending', orderId: attempt.order_id };
  if (verified.status === 'failed' || verified.status === 'abandoned') {
    await withTransaction(ctx.pool, async (tx) => {
      const res = await tx.query(
        `UPDATE payment_attempts SET status = $2, failure_reason = coalesce(failure_reason, $3), updated_at = now()
          WHERE id = $1 AND status IN ('initiated','pending','uncertain')`,
        [attempt.id, verified.status, `provider reported ${verified.status}`],
      );
      if (res.rowCount) {
        await tx.query(`INSERT INTO order_events (order_id, kind, actor_kind, data) VALUES ($1, 'payment_failed', 'provider', $2)`, [
          attempt.order_id,
          JSON.stringify({ reference, status: verified.status }),
        ]);
      }
    });
    return { outcome: 'failed', orderId: attempt.order_id };
  }
  // Provider says succeeded: amount and currency must match exactly.
  if (verified.amountMinor !== attempt.amount_minor || (verified.currency ?? 'NGN') !== attempt.currency) {
    await withTransaction(ctx.pool, async (tx) => {
      await tx.query(`UPDATE payment_attempts SET status = 'uncertain', failure_reason = $2, updated_at = now() WHERE id = $1 AND status <> 'succeeded'`, [
        attempt.id,
        `amount mismatch: provider ${verified.amountMinor} ${verified.currency}, expected ${attempt.amount_minor} ${attempt.currency}`,
      ]);
      await recordAudit(tx, ctx, {
        action: 'payment.amount_mismatch',
        targetKind: 'payment_attempt',
        targetId: attempt.id,
        data: { reference, expected: attempt.amount_minor, received: verified.amountMinor, currency: verified.currency },
      });
    });
    return { outcome: 'mismatch', orderId: attempt.order_id };
  }
  return captureSucceededPayment(ctx, attempt, verified);
}

async function captureSucceededPayment(ctx: AppContext, attempt: PaymentAttemptRow, verified: VerifyPaymentResult): Promise<ApplyResult> {
  const orderId = attempt.order_id!;
  const peek = await one<{ reservation_id: string | null; listing_id: string }>(
    ctx.pool,
    `SELECT o.reservation_id, oi.listing_id FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE o.id = $1 LIMIT 1`,
    [orderId],
  );
  return withTransaction(ctx.pool, async (tx) => {
    // Lock order: inventory_stock → reservations → orders → payment_attempts → payouts.
    await lockStock(tx, peek.listing_id);
    if (peek.reservation_id) await lockReservation(tx, peek.reservation_id);
    const order = await one<OrderRow>(tx, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    const a = await one<PaymentAttemptRow>(tx, 'SELECT * FROM payment_attempts WHERE id = $1 FOR UPDATE', [attempt.id]);
    if (a.status === 'succeeded' || a.status === 'duplicate') return { outcome: 'already_applied' as const, orderId };
    const paidAlready = await maybeOne(tx, `SELECT 1 AS ok FROM payment_attempts WHERE order_id = $1 AND status = 'succeeded'`, [orderId]);
    if (paidAlready) {
      // A second successful payment for the same order: record the money and refund it automatically.
      await tx.query(`UPDATE payment_attempts SET status = 'duplicate', succeeded_at = $2, provider_transaction_id = $3, updated_at = now() WHERE id = $1`, [
        a.id,
        verified.paidAt ?? ctx.now(),
        verified.providerTransactionId,
      ]);
      await postCapture(tx, order, a, 'refunds_only');
      await createRefund(tx, ctx, {
        orderId,
        paymentAttemptId: a.id,
        amountMinor: a.amount_minor,
        reason: 'duplicate_payment',
        note: 'Second successful payment for an already-paid order.',
        autoApprove: true,
        idempotencyKey: `duplicate:${a.id}`,
      });
      await notifyUser(tx, {
        userId: order.buyer_user_id,
        topic: 'transactional',
        kind: 'duplicate_payment',
        title: `You paid twice for order ${order.number}`,
        body: 'We received a second payment for this order. A full refund of the extra payment has been started.',
        link: `/orders/${orderId}`,
        dedupeKey: `duplicate-payment:${a.id}`,
      });
      return { outcome: 'duplicate_refunded' as const, orderId };
    }
    const conversion = order.reservation_id ? await convertReservation(tx, order.reservation_id) : { converted: false, reallocated: false };
    await tx.query(`UPDATE payment_attempts SET status = 'succeeded', succeeded_at = $2, provider_transaction_id = $3, updated_at = now() WHERE id = $1`, [
      a.id,
      verified.paidAt ?? ctx.now(),
      verified.providerTransactionId,
    ]);
    if (!conversion.converted) {
      // Late payment after the hold was released and the unit is gone: never sell it twice — refund in full.
      await tx.query(
        `UPDATE orders SET status = 'cancelled', payment_status = 'refund_pending', cancel_reason = coalesce(cancel_reason, 'item_unavailable_at_payment'),
                cancelled_at = coalesce(cancelled_at, now()), paid_at = $2, updated_at = now() WHERE id = $1`,
        [orderId, verified.paidAt ?? ctx.now()],
      );
      await postCapture(tx, order, a, 'refunds_only');
      await createRefund(tx, ctx, {
        orderId,
        paymentAttemptId: a.id,
        amountMinor: a.amount_minor,
        reason: 'late_payment_after_release',
        note: 'Payment arrived after the reservation was released and the item was no longer available.',
        autoApprove: true,
        idempotencyKey: `late:${a.id}`,
      });
      await tx.query(`INSERT INTO order_events (order_id, kind, actor_kind, data) VALUES ($1, 'late_payment_refunded', 'provider', $2)`, [
        orderId,
        JSON.stringify({ reference: a.reference }),
      ]);
      await notifyUser(tx, {
        userId: order.buyer_user_id,
        topic: 'transactional',
        kind: 'late_payment_refund',
        title: `Order ${order.number}: item no longer available`,
        body: 'The item was no longer available when your payment arrived. A full refund has been started.',
        link: `/orders/${orderId}`,
        dedupeKey: `late-refund:${a.id}`,
      });
      await recordAudit(tx, ctx, { action: 'payment.late_refund', targetKind: 'order', targetId: orderId, data: { reference: a.reference } });
      return { outcome: 'late_refunded' as const, orderId };
    }
    // Normal capture (or a late payment re-allocated to the same, still available unit).
    const now = ctx.now();
    const dispatchDays = order.delivery_terms?.dispatchDays ?? 2;
    await tx.query(
      `UPDATE orders SET status = 'confirmed', payment_status = 'paid', fulfilment_status = 'awaiting_dispatch', payout_status = 'held',
              paid_at = $2, cancelled_at = NULL, cancel_reason = NULL, updated_at = now() WHERE id = $1`,
      [orderId, verified.paidAt ?? now],
    );
    await tx.query(
      `INSERT INTO shipments (order_id, method, status, confidence, quote_minor, dispatch_by, transit_days_min, transit_days_max)
       VALUES ($1, $2, 'pending', 'none', $3, $4, $5, $6) ON CONFLICT (order_id) DO NOTHING`,
      [orderId, order.delivery_method, order.shipping_minor, new Date(now.getTime() + Math.max(dispatchDays, 1) * 86_400_000), order.delivery_terms?.transitDaysMin ?? null, order.delivery_terms?.transitDaysMax ?? null],
    );
    const proceeds = sellerProceeds(order);
    await tx.query(
      `INSERT INTO payouts (shop_id, order_id, amount_minor, status, hold_reason) VALUES ($1, $2, $3, 'held', 'awaiting_delivery')
       ON CONFLICT (order_id) DO NOTHING`,
      [order.shop_id, orderId, proceeds],
    );
    await postCapture(tx, order, a, 'normal');
    await tx.query(`INSERT INTO order_events (order_id, kind, actor_kind, data) VALUES ($1, $2, 'provider', $3)`, [
      orderId,
      conversion.reallocated ? 'payment_confirmed_late_reallocated' : 'payment_confirmed',
      JSON.stringify({ reference: a.reference, amountMinor: a.amount_minor }),
    ]);
    const owner = await one<{ owner_user_id: string }>(tx, 'SELECT owner_user_id FROM shops WHERE id = $1', [order.shop_id]);
    await notifyUser(tx, {
      userId: order.buyer_user_id,
      topic: 'transactional',
      kind: 'order_paid',
      title: `Payment confirmed for order ${order.number}`,
      body: `We’ve told the seller. They usually dispatch within ${dispatchDays} ${dispatchDays === 1 ? 'day' : 'days'}.`,
      link: `/orders/${orderId}`,
      dedupeKey: `order-paid-buyer:${orderId}`,
    });
    await notifyUser(tx, {
      userId: owner.owner_user_id,
      topic: 'transactional',
      kind: 'order_paid_seller',
      title: `New order ${order.number} — ${formatNaira(order.items_total_minor)}`,
      body: 'Payment is confirmed. Please dispatch by the date shown on the order.',
      link: `/sell/orders/${orderId}`,
      dedupeKey: `order-paid-seller:${orderId}`,
    });
    await enqueue(tx, { topic: 'order.paid', aggregateId: orderId, payload: { orderId, source: order.source, sourceId: order.source_id }, dedupeKey: `order.paid:${orderId}` });
    return { outcome: conversion.reallocated ? ('late_reallocated' as const) : ('paid' as const), orderId };
  });
}

export function sellerProceeds(o: Pick<OrderRow, 'items_total_minor' | 'commission_minor' | 'shipping_minor' | 'delivery_method'>): number {
  return o.items_total_minor - o.commission_minor + (o.delivery_method === 'integrated' ? 0 : o.shipping_minor);
}

/**
 * Ledger capture. 'normal' allocates the money to seller/commission/fees/courier; 'refunds_only' records money that
 * must go back to the buyer (late or duplicate payment) in refunds_payable.
 */
async function postCapture(tx: Queryable, o: OrderRow, a: PaymentAttemptRow, mode: 'normal' | 'refunds_only'): Promise<void> {
  const lines: LedgerLine[] =
    mode === 'refunds_only'
      ? [
          { account: 'provider_clearing', amountMinor: a.amount_minor },
          { account: 'refunds_payable', amountMinor: -a.amount_minor },
        ]
      : [
          { account: 'provider_clearing', amountMinor: a.amount_minor },
          { account: 'seller_payable', amountMinor: -sellerProceeds(o), shopId: o.shop_id },
          { account: 'platform_commission', amountMinor: -o.commission_minor },
          { account: 'platform_fees', amountMinor: -o.buyer_fee_minor },
          { account: 'courier_payable', amountMinor: -(o.delivery_method === 'integrated' ? o.shipping_minor : 0) },
        ];
  await postLedgerTransaction(tx, {
    kind: 'payment_captured',
    orderId: o.id,
    description: mode === 'normal' ? `Payment for order ${o.number}` : `Payment to refund for order ${o.number}`,
    idempotencyKey: `capture:${a.id}`,
    lines,
  });
}

/** Totals helper reused by checkout (kept here so capture and checkout use identical arithmetic). */
export { computeOrderTotals };
