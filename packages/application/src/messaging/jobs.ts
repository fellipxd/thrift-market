import { many, maybeOne, type Queryable } from '@thrift/database';
import { registerOutboxHandler } from '../jobs/outbox-dispatcher';
import { postSystemMessage } from './messages';

/**
 * Outbox: when an order is paid, link the buyer's conversation about that item to the order and post a notice.
 * Idempotent: a conversation already linked to this order is left alone.
 */
export async function linkOrderConversation(tx: Queryable, payload: { orderId?: string }): Promise<void> {
  if (!payload.orderId) return;
  const order = await maybeOne<{ id: string; number: string; buyer_user_id: string }>(tx, 'SELECT id, number, buyer_user_id FROM orders WHERE id = $1', [payload.orderId]);
  if (!order) return;
  const convs = await many<{ id: string }>(
    tx,
    `UPDATE conversations SET order_id = $1
      WHERE buyer_user_id = $2 AND listing_id IN (SELECT listing_id FROM order_items WHERE order_id = $1) AND order_id IS DISTINCT FROM $1
      RETURNING id`,
    [order.id, order.buyer_user_id],
  );
  for (const c of convs) {
    await postSystemMessage(tx, { conversationId: c.id, body: `Order ${order.number} was paid. The seller will arrange delivery.` });
  }
}

export function registerMessagingJobs(): void {
  registerOutboxHandler('order.paid', (_ctx, ev, tx) => linkOrderConversation(tx, ev.payload as never));
}
