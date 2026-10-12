import { sellerCancelInput } from '@thrift/contracts';
import { DomainError } from '@thrift/domain';
import { one, maybeOne, withTransaction } from '@thrift/database';
import { recordAudit } from '../core/audit';
import { requireUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { parseInput } from '../core/validation';
import { orderHolds } from '../checkout/holds';
import { lockStock, restoreSoldUnits, withdrawStock } from '../inventory/authority';
import { notifyUser } from '../notifications/notify';
import { createRefund } from '../payments/refunds';

/**
 * Seller cancels a paid order before dispatch: full automatic refund, payout cancelled, every piece returns to the
 * seller's stock (or is withdrawn if the seller can no longer sell it), and the cancellation counts against
 * service reputation (order_events 'seller_cancelled').
 */
export async function cancelOrderBySeller(ctx: AppContext, raw: unknown): Promise<{ orderId: string; refundId: string }> {
  const user = requireUser(ctx);
  const input = parseInput(sellerCancelInput, raw);
  const peek = await maybeOne<{ id: string }>(
    ctx.pool,
    `SELECT o.id FROM orders o JOIN shop_members m ON m.shop_id = o.shop_id AND m.user_id = $2 WHERE o.id = $1`,
    [input.orderId, user.userId],
  );
  if (!peek) throw new DomainError('NOT_FOUND', 'Order not found.');
  const items = await orderHolds(ctx.pool, peek.id);
  return withTransaction(ctx.pool, async (tx) => {
    for (const it of items) await lockStock(tx, it.listingId);
    const o = await one<{ id: string; number: string; status: string; payment_status: string; fulfilment_status: string; total_minor: number; buyer_user_id: string }>(
      tx,
      'SELECT id, number, status, payment_status, fulfilment_status, total_minor, buyer_user_id FROM orders WHERE id = $1 FOR UPDATE',
      [peek.id],
    );
    if (o.status !== 'confirmed' || o.payment_status !== 'paid') throw new DomainError('INVALID_STATE', 'Only paid orders that haven’t been dispatched can be cancelled.');
    if (o.fulfilment_status !== 'awaiting_dispatch') throw new DomainError('INVALID_STATE', 'This order has already been dispatched. Open a support case instead.');
    for (const it of items) {
      await restoreSoldUnits(tx, { listingId: it.listingId, quantity: it.quantity, reason: 'seller_cancelled_order', actorUserId: user.userId });
      if (!input.restock) await withdrawStock(tx, { listingId: it.listingId, quantity: it.quantity, reason: 'seller_cancelled_not_restocked', actorUserId: user.userId });
    }
    await tx.query(
      `UPDATE orders SET status = 'cancelled', fulfilment_status = 'cancelled', cancel_reason = $2, cancelled_at = now(), updated_at = now() WHERE id = $1`,
      [o.id, `seller: ${input.reason}`],
    );
    await tx.query(`UPDATE shipments SET status = 'cancelled', updated_at = now() WHERE order_id = $1 AND status = 'pending'`, [o.id]);
    await tx.query(`UPDATE payouts SET status = 'cancelled', hold_reason = 'order_cancelled', updated_at = now() WHERE order_id = $1 AND status IN ('held','blocked','eligible')`, [o.id]);
    await tx.query(`UPDATE orders SET payout_status = 'reversed' WHERE id = $1`, [o.id]);
    const refund = await createRefund(tx, ctx, {
      orderId: o.id,
      amountMinor: o.total_minor,
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
      body: `Reason: ${input.reason}. A full refund has been started.`,
      link: `/orders/${o.id}`,
      dedupeKey: `seller-cancel:${o.id}`,
    });
    return { orderId: o.id, refundId: refund.id };
  });
}
