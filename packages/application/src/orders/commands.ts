import { sellerCancelInput, sellerCancelItemsInput } from '@thrift/contracts';
import { DomainError, formatNaira } from '@thrift/domain';
import { many, one, maybeOne, withTransaction, type Queryable } from '@thrift/database';
import { recordAudit } from '../core/audit';
import { requireUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { parseInput } from '../core/validation';
import { lockStock, restoreSoldUnits, withdrawStock } from '../inventory/authority';
import { notifyUser } from '../notifications/notify';
import { createRefund, type RefundAllocation } from '../payments/refunds';
import { refundableMinor } from '../disputes/disputes';

interface ItemRow {
  id: string;
  listing_id: string;
  quantity: number;
  unit_price_minor: number;
  shipping_share_minor: number;
  buyer_fee_share_minor: number;
  commission_share_minor: number;
  cancelled_at: Date | null;
  title: string;
  [k: string]: unknown;
}

async function orderItemRows(db: Queryable, orderId: string): Promise<ItemRow[]> {
  return many<ItemRow>(
    db,
    `SELECT id, listing_id, quantity, unit_price_minor, shipping_share_minor, buyer_fee_share_minor, commission_share_minor, cancelled_at,
            coalesce(snapshot->>'title', 'Item') AS title
       FROM order_items WHERE order_id = $1 ORDER BY listing_id, id`,
    [orderId],
  );
}

async function sellerOrderId(ctx: AppContext, orderId: string, userId: string): Promise<string> {
  const peek = await maybeOne<{ id: string }>(
    ctx.pool,
    `SELECT o.id FROM orders o JOIN shop_members m ON m.shop_id = o.shop_id AND m.user_id = $2 WHERE o.id = $1`,
    [orderId, userId],
  );
  if (!peek) throw new DomainError('NOT_FOUND', 'Order not found.');
  return peek.id;
}

const CANCELLABLE_PAYMENT = ['paid', 'refund_pending', 'partially_refunded'];

/**
 * Seller cancels a paid order before dispatch: full automatic refund, payout cancelled, every piece returns to the
 * seller's stock (or is withdrawn if the seller can no longer sell it), and the cancellation counts against
 * service reputation (order_events 'seller_cancelled').
 */
export async function cancelOrderBySeller(ctx: AppContext, raw: unknown): Promise<{ orderId: string; refundId: string }> {
  const user = requireUser(ctx);
  const input = parseInput(sellerCancelInput, raw);
  const orderId = await sellerOrderId(ctx, input.orderId, user.userId);
  const peekItems = await orderItemRows(ctx.pool, orderId);
  return withTransaction(ctx.pool, async (tx) => {
    for (const it of peekItems) await lockStock(tx, it.listing_id);
    const o = await one<{
      id: string; number: string; status: string; payment_status: string; fulfilment_status: string; total_minor: number; buyer_user_id: string;
      shipping_minor: number; delivery_method: string;
    }>(
      tx,
      'SELECT id, number, status, payment_status, fulfilment_status, total_minor, buyer_user_id, shipping_minor, delivery_method FROM orders WHERE id = $1 FOR UPDATE',
      [orderId],
    );
    if (o.status !== 'confirmed' || !CANCELLABLE_PAYMENT.includes(o.payment_status)) throw new DomainError('INVALID_STATE', 'Only paid orders that haven’t been dispatched can be cancelled.');
    if (o.fulfilment_status !== 'awaiting_dispatch') throw new DomainError('INVALID_STATE', 'This order has already been dispatched. Open a support case instead.');
    const items = await orderItemRows(tx, orderId);
    const remaining = items.filter((it) => !it.cancelled_at);
    for (const it of remaining) {
      await restoreSoldUnits(tx, { listingId: it.listing_id, quantity: it.quantity, reason: 'seller_cancelled_order', actorUserId: user.userId });
      if (!input.restock) await withdrawStock(tx, { listingId: it.listing_id, quantity: it.quantity, reason: 'seller_cancelled_not_restocked', actorUserId: user.userId });
    }
    // After earlier per-item cancellations, refund exactly what is left: the remaining pieces, their fee shares and the
    // whole delivery fee (nothing ships now), split back to the accounts that received it.
    const partlyRefunded = remaining.length < items.length;
    const amountMinor = partlyRefunded ? await refundableMinor(tx, orderId) : o.total_minor;
    let allocation: RefundAllocation | null = null;
    if (partlyRefunded) {
      const itemsMinor = remaining.reduce((sum, it) => sum + it.unit_price_minor * it.quantity, 0);
      const commissionMinor = remaining.reduce((sum, it) => sum + Number(it.commission_share_minor), 0);
      const feesMinor = remaining.reduce((sum, it) => sum + Number(it.buyer_fee_share_minor), 0);
      const courierMinor = o.delivery_method === 'integrated' ? Number(o.shipping_minor) : 0;
      const sellerMinor = itemsMinor - commissionMinor + (o.delivery_method === 'integrated' ? 0 : Number(o.shipping_minor));
      allocation = { sellerMinor, commissionMinor, feesMinor, courierMinor };
      if (sellerMinor + commissionMinor + feesMinor + courierMinor !== amountMinor) {
        throw new DomainError('INVALID_STATE', 'This order’s refunds don’t add up. Ask support to cancel it.');
      }
    }
    await tx.query(
      `UPDATE orders SET status = 'cancelled', fulfilment_status = 'cancelled', cancel_reason = $2, cancelled_at = now(), updated_at = now() WHERE id = $1`,
      [o.id, `seller: ${input.reason}`],
    );
    await tx.query(`UPDATE shipments SET status = 'cancelled', updated_at = now() WHERE order_id = $1 AND status = 'pending'`, [o.id]);
    await tx.query(`UPDATE payouts SET status = 'cancelled', hold_reason = 'order_cancelled', updated_at = now() WHERE order_id = $1 AND status IN ('held','blocked','eligible')`, [o.id]);
    await tx.query(`UPDATE orders SET payout_status = 'reversed' WHERE id = $1`, [o.id]);
    await tx.query(`UPDATE order_items SET cancelled_at = now(), cancel_reason = $2 WHERE order_id = $1 AND cancelled_at IS NULL`, [o.id, `seller: ${input.reason}`]);
    const refund = await createRefund(tx, ctx, {
      orderId: o.id,
      amountMinor,
      allocation,
      reason: 'seller_cancelled',
      note: input.reason,
      requestedBy: user.userId,
      autoApprove: true,
      idempotencyKey: `seller-cancel:${o.id}`,
    });
    await tx.query(`INSERT INTO order_events (order_id, kind, actor_kind, actor_user_id, data) VALUES ($1, 'seller_cancelled', 'seller', $2, $3)`, [
      o.id,
      user.userId,
      JSON.stringify({ reason: input.reason, restock: input.restock }),
    ]);
    await recordAudit(tx, ctx, { action: 'order.seller_cancelled', targetKind: 'order', targetId: o.id, reason: input.reason });
    await notifyUser(tx, {
      userId: o.buyer_user_id,
      topic: 'transactional',
      kind: 'order_cancelled_by_seller',
      title: `Order ${o.number} was cancelled by the seller`,
      body: partlyRefunded
        ? `Reason: ${input.reason}. A refund of the remaining ${formatNaira(amountMinor)} has been started.`
        : `Reason: ${input.reason}. A full refund has been started.`,
      link: `/orders/${o.id}`,
      dedupeKey: `seller-cancel:${o.id}`,
    });
    return { orderId: o.id, refundId: refund.id };
  });
}

/**
 * Seller cancels some pieces of a paid multi-piece order before dispatch (e.g. one is damaged). The buyer gets back
 * each piece's price and its frozen share of the buyer fee; delivery is not refunded because the rest still ships.
 * Choosing every remaining piece is a whole-order cancellation (which also refunds delivery).
 */
export async function cancelOrderItemsBySeller(ctx: AppContext, raw: unknown): Promise<{ orderId: string; refundId: string; wholeOrder: boolean }> {
  const user = requireUser(ctx);
  const input = parseInput(sellerCancelItemsInput, raw);
  const orderId = await sellerOrderId(ctx, input.orderId, user.userId);
  const peekItems = await orderItemRows(ctx.pool, orderId);
  const chosen = new Set(input.orderItemIds.map((id) => id.toLowerCase()));
  const active = peekItems.filter((it) => !it.cancelled_at);
  if ([...chosen].some((id) => !peekItems.some((it) => it.id === id))) throw new DomainError('NOT_FOUND', 'One of those pieces isn’t in this order.');
  if (active.length > 0 && active.every((it) => chosen.has(it.id))) {
    const whole = await cancelOrderBySeller(ctx, { orderId, reason: input.reason, restock: input.restock });
    return { ...whole, wholeOrder: true };
  }
  return withTransaction(ctx.pool, async (tx) => {
    for (const it of peekItems) if (chosen.has(it.id)) await lockStock(tx, it.listing_id);
    const o = await one<{ id: string; number: string; status: string; payment_status: string; fulfilment_status: string; buyer_user_id: string }>(
      tx,
      'SELECT id, number, status, payment_status, fulfilment_status, buyer_user_id FROM orders WHERE id = $1 FOR UPDATE',
      [orderId],
    );
    if (o.status !== 'confirmed' || !CANCELLABLE_PAYMENT.includes(o.payment_status)) throw new DomainError('INVALID_STATE', 'Only paid orders that haven’t been dispatched can be changed.');
    if (o.fulfilment_status !== 'awaiting_dispatch') throw new DomainError('INVALID_STATE', 'This order has already been dispatched. Open a support case instead.');
    const items = (await orderItemRows(tx, orderId)).filter((it) => chosen.has(it.id));
    if (items.some((it) => it.cancelled_at)) throw new DomainError('CONFLICT', 'One of those pieces was already cancelled.');
    for (const it of items) {
      await restoreSoldUnits(tx, { listingId: it.listing_id, quantity: it.quantity, reason: 'seller_cancelled_item', actorUserId: user.userId });
      if (!input.restock) await withdrawStock(tx, { listingId: it.listing_id, quantity: it.quantity, reason: 'seller_cancelled_not_restocked', actorUserId: user.userId });
    }
    const itemsMinor = items.reduce((sum, it) => sum + it.unit_price_minor * it.quantity, 0);
    const commissionMinor = items.reduce((sum, it) => sum + Number(it.commission_share_minor), 0);
    const feesMinor = items.reduce((sum, it) => sum + Number(it.buyer_fee_share_minor), 0);
    const allocation: RefundAllocation = { sellerMinor: itemsMinor - commissionMinor, commissionMinor, feesMinor, courierMinor: 0 };
    const amountMinor = itemsMinor + feesMinor;
    const refund = await createRefund(tx, ctx, {
      orderId,
      amountMinor,
      allocation,
      reason: 'seller_cancelled_items',
      note: input.reason,
      requestedBy: user.userId,
      autoApprove: true,
      idempotencyKey: `seller-cancel-items:${orderId}:${items.map((it) => it.id).sort().join(',')}`,
    });
    await tx.query(`UPDATE order_items SET cancelled_at = now(), cancel_reason = $2, refund_id = $3 WHERE id = ANY($1::uuid[])`, [
      items.map((it) => it.id),
      `seller: ${input.reason}`,
      refund.id,
    ]);
    // Order totals stay as paid (the purchase record); the refund and its frozen split carry the change, and the
    // seller's payout shrinks by the seller part when the refund is confirmed.
    await tx.query(`INSERT INTO order_events (order_id, kind, actor_kind, actor_user_id, data) VALUES ($1, 'seller_cancelled_items', 'seller', $2, $3)`, [
      orderId,
      user.userId,
      JSON.stringify({ reason: input.reason, restock: input.restock, orderItemIds: items.map((it) => it.id), refundId: refund.id, amountMinor }),
    ]);
    await recordAudit(tx, ctx, { action: 'order.seller_cancelled_items', targetKind: 'order', targetId: orderId, reason: input.reason, data: { orderItemIds: items.map((it) => it.id) } });
    const titles = items.map((it) => it.title).join(', ');
    await notifyUser(tx, {
      userId: o.buyer_user_id,
      topic: 'transactional',
      kind: 'order_items_cancelled_by_seller',
      title: `Order ${o.number}: ${items.length === 1 ? 'a piece was' : `${items.length} pieces were`} cancelled`,
      body: `${titles} — reason: ${input.reason}. A refund of ${formatNaira(amountMinor)} has been started. The rest of your order still ships.`,
      link: `/orders/${orderId}`,
      dedupeKey: `seller-cancel-items:${refund.id}`,
    });
    return { orderId, refundId: refund.id, wholeOrder: false };
  });
}
