import { formatNaira } from '@thrift/domain';
import { many, maybeOne, withTransaction, type Queryable } from '@thrift/database';
import type { AppContext } from '../core/context';
import { registerOutboxHandler } from '../jobs/outbox-dispatcher';
import { registerTask } from '../jobs/tasks';
import { postSystemMessage } from '../messaging/messages';
import { notifyUser } from '../notifications/notify';

/**
 * Worker: pending offers past their expiry become 'expired'. Each offer is handled in its own short transaction
 * that locks the thread first (lock order) and skips rows another worker is already handling.
 */
export async function expireOffers(ctx: AppContext, batchSize = 100): Promise<{ expired: number }> {
  const due = await many<{ id: string; thread_id: string }>(
    ctx.pool,
    `SELECT id, thread_id FROM offers WHERE status = 'pending' AND expires_at <= now() ORDER BY expires_at LIMIT $1`,
    [batchSize],
  );
  let expired = 0;
  for (const d of due) {
    const done = await withTransaction(ctx.pool, async (tx) => {
      const thread = await maybeOne<{ id: string; conversation_id: string | null; buyer_user_id: string; shop_id: string }>(
        tx,
        'SELECT id, conversation_id, buyer_user_id, shop_id FROM offer_threads WHERE id = $1 FOR UPDATE SKIP LOCKED',
        [d.thread_id],
      );
      if (!thread) return false;
      const offer = await maybeOne<{ id: string; from_party: 'buyer' | 'seller'; amount_minor: number }>(
        tx,
        `UPDATE offers SET status = 'expired', responded_at = now() WHERE id = $1 AND status = 'pending' AND expires_at <= now()
         RETURNING id, from_party, amount_minor`,
        [d.id],
      );
      if (!offer) return false;
      await tx.query('UPDATE offer_threads SET updated_at = now() WHERE id = $1', [thread.id]);
      if (thread.conversation_id) {
        await postSystemMessage(tx, {
          conversationId: thread.conversation_id,
          body: `The offer of ${formatNaira(offer.amount_minor)} expired without a reply.`,
          offerId: offer.id,
        });
      }
      const author = offer.from_party === 'buyer' ? [thread.buyer_user_id] : await shopOwner(tx, thread.shop_id);
      for (const userId of author) {
        await notifyUser(tx, {
          userId,
          topic: 'transactional',
          kind: 'offer_expired',
          title: `Your offer of ${formatNaira(offer.amount_minor)} expired`,
          body: 'You can make a new offer if the item is still available.',
          link: thread.conversation_id ? `/inbox/${thread.conversation_id}` : null,
          dedupeKey: `offer-expired:${offer.id}`,
        });
      }
      return true;
    });
    if (done) expired++;
  }
  return { expired };
}

async function shopOwner(db: Queryable, shopId: string): Promise<string[]> {
  const r = await maybeOne<{ owner_user_id: string }>(db, 'SELECT owner_user_id FROM shops WHERE id = $1', [shopId]);
  return r ? [r.owner_user_id] : [];
}

/** Outbox: an accepted offer's hold ended without payment → the thread lapses (idempotent). */
export async function onReservationReleased(tx: Queryable, payload: { reservationId?: string; source?: string; sourceId?: string | null }): Promise<void> {
  if (payload.source !== 'offer' || !payload.sourceId || !payload.reservationId) return;
  const thread = await maybeOne<{ id: string; status: string; reservation_id: string | null; conversation_id: string | null; buyer_user_id: string }>(
    tx,
    'SELECT id, status, reservation_id, conversation_id, buyer_user_id FROM offer_threads WHERE id = $1 FOR UPDATE',
    [payload.sourceId],
  );
  if (!thread || thread.status !== 'accepted' || thread.reservation_id !== payload.reservationId) return;
  await tx.query(`UPDATE offer_threads SET status = 'expired', updated_at = now() WHERE id = $1`, [thread.id]);
  if (thread.conversation_id) {
    await postSystemMessage(tx, { conversationId: thread.conversation_id, body: 'The hold on this item expired before payment, so the accepted offer has lapsed.' });
  }
  await notifyUser(tx, {
    userId: thread.buyer_user_id,
    topic: 'transactional',
    kind: 'offer_hold_expired',
    title: 'Your accepted offer lapsed',
    body: 'The hold ended before payment was completed. You can make a new offer if the item is still available.',
    link: thread.conversation_id ? `/inbox/${thread.conversation_id}` : null,
    dedupeKey: `offer-hold-expired:${thread.id}`,
  });
}

/**
 * Outbox: an order was paid. An offer-sourced order completes its thread; when the listing has no units left,
 * other open negotiations on it are closed (pending offers in them expire). Idempotent.
 */
export async function onOrderPaid(tx: Queryable, payload: { orderId?: string }): Promise<void> {
  if (!payload.orderId) return;
  const order = await maybeOne<{ id: string; source: string; source_id: string | null; number: string }>(
    tx,
    'SELECT id, source, source_id, number FROM orders WHERE id = $1',
    [payload.orderId],
  );
  if (!order) return;
  if (order.source === 'offer' && order.source_id) {
    await tx.query(`UPDATE offer_threads SET status = 'completed', updated_at = now() WHERE id = $1 AND status IN ('accepted','expired')`, [order.source_id]);
  }
  const listings = await many<{ listing_id: string }>(tx, 'SELECT DISTINCT listing_id FROM order_items WHERE order_id = $1', [order.id]);
  for (const { listing_id } of listings) {
    const stock = await maybeOne<{ left: number }>(tx, 'SELECT quantity_available + quantity_reserved AS left FROM inventory_stock WHERE listing_id = $1', [listing_id]);
    if (!stock || stock.left > 0) continue;
    const open = await many<{ id: string; conversation_id: string | null }>(
      tx,
      `SELECT id, conversation_id FROM offer_threads WHERE listing_id = $1 AND status = 'open' AND id IS DISTINCT FROM $2 ORDER BY id FOR UPDATE`,
      [listing_id, order.source === 'offer' ? order.source_id : null],
    );
    for (const t of open) {
      await tx.query(`UPDATE offers SET status = 'expired', responded_at = now() WHERE thread_id = $1 AND status = 'pending'`, [t.id]);
      await tx.query(`UPDATE offer_threads SET status = 'closed_unavailable', updated_at = now() WHERE id = $1`, [t.id]);
      if (t.conversation_id) await postSystemMessage(tx, { conversationId: t.conversation_id, body: 'This piece has sold, so this negotiation is closed.' });
    }
  }
}

export function registerOffersJobs(): void {
  registerTask({ name: 'offers.expire', intervalMs: 30_000, run: (ctx) => expireOffers(ctx) });
  registerOutboxHandler('reservation.released', (_ctx, ev, tx) => onReservationReleased(tx, ev.payload as never));
  registerOutboxHandler('order.paid', (_ctx, ev, tx) => onOrderPaid(tx, ev.payload as never));
}
