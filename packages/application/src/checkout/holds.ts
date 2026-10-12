import { many, one, type Queryable } from '@thrift/database';
import { enqueue } from '../core/outbox';

/**
 * A pending order is the checkout group (doc 06): each order item carries its own hold, and the group's holds are
 * allocated, expired, released and converted together. Holds are always visited in listing-id order so every path
 * takes inventory_stock locks in the same sequence (ADR-0008).
 */
export interface OrderHold {
  orderItemId: string;
  listingId: string;
  reservationId: string | null;
  quantity: number;
}

export async function orderHolds(db: Queryable, orderId: string): Promise<OrderHold[]> {
  const rows = await many<{ id: string; listing_id: string; reservation_id: string | null; quantity: number }>(
    db,
    'SELECT id, listing_id, reservation_id, quantity FROM order_items WHERE order_id = $1 ORDER BY listing_id, id',
    [orderId],
  );
  return rows.map((r) => ({ orderItemId: r.id, listingId: r.listing_id, reservationId: r.reservation_id, quantity: r.quantity }));
}

/**
 * Expiry and status of an order's holds as one unit: the earliest deadline; 'active' only when every hold is active,
 * 'payment_pending' when every hold is still held and at least one waits for a payment outcome, otherwise the first
 * closed status (released, expired, converted).
 */
export async function orderHoldState(db: Queryable, orderId: string): Promise<{ expiresAt: Date | null; allActive: boolean; status: string | null }> {
  const rows = await many<{ expires_at: Date; status: string }>(
    db,
    'SELECT r.expires_at, r.status FROM order_items oi JOIN reservations r ON r.id = oi.reservation_id WHERE oi.order_id = $1 ORDER BY r.listing_id',
    [orderId],
  );
  if (rows.length === 0) return { expiresAt: null, allActive: false, status: null };
  const expiresAt = new Date(Math.min(...rows.map((r) => new Date(r.expires_at).getTime())));
  const allActive = rows.every((r) => r.status === 'active');
  const held = rows.every((r) => r.status === 'active' || r.status === 'payment_pending');
  const status = allActive ? 'active' : held ? 'payment_pending' : rows.find((r) => r.status !== 'active' && r.status !== 'payment_pending')!.status;
  return { expiresAt, allActive, status };
}

/**
 * The unpaid order(s) holding this reservation and every hold in them, in lock order. A reservation outside any
 * unpaid order (e.g. an accepted offer not yet at checkout) is its own group.
 */
export async function liveGroupFor(db: Queryable, reservationId: string): Promise<{ orderIds: string[]; reservationIds: string[] }> {
  const rows = await many<{ order_id: string; reservation_id: string }>(
    db,
    `SELECT oi.order_id, oi.reservation_id
       FROM order_items oi JOIN reservations r ON r.id = oi.reservation_id
      WHERE oi.order_id IN (SELECT x.order_id FROM order_items x JOIN orders o ON o.id = x.order_id
                             WHERE x.reservation_id = $1 AND o.status = 'pending_payment')
      ORDER BY r.listing_id, r.id`,
    [reservationId],
  );
  const orderIds = [...new Set(rows.map((r) => r.order_id))];
  const reservationIds = [...new Set(rows.map((r) => r.reservation_id))];
  if (!reservationIds.includes(reservationId)) reservationIds.push(reservationId);
  return { orderIds, reservationIds };
}

/** Tells other modules (offers, auctions) that a hold ended without a sale. */
export async function enqueueReservationReleased(tx: Queryable, reservationId: string): Promise<void> {
  const r = await one<{ source: string; source_id: string | null; listing_id: string }>(tx, 'SELECT source, source_id, listing_id FROM reservations WHERE id = $1', [reservationId]);
  await enqueue(tx, {
    topic: 'reservation.released',
    aggregateId: reservationId,
    payload: { reservationId, source: r.source, sourceId: r.source_id, listingId: r.listing_id },
    dedupeKey: `reservation.released:${reservationId}`,
  });
}
