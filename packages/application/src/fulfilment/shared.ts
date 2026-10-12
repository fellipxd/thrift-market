import { assertTransition, DomainError, FULFILMENT_STATUS, SHIPMENT_STATUS, type FulfilmentStatus, type ShipmentStatus, type TrackingConfidence } from '@thrift/domain';
import { maybeOne, one, type Queryable } from '@thrift/database';
import type { AppContext } from '../core/context';
import { enqueue } from '../core/outbox';
import { notifyUser } from '../notifications/notify';
import { refreshPayoutForOrder } from '../payouts/payouts';

export interface FulfilmentOrder {
  id: string;
  number: string;
  shop_id: string;
  buyer_user_id: string;
  status: string;
  payment_status: string;
  fulfilment_status: FulfilmentStatus;
  dispute_status: string;
  delivery_method: 'integrated' | 'seller_arranged' | 'pickup';
  dispatched_at: Date | null;
  delivered_at: Date | null;
  buyer_confirmed_at: Date | null;
  shipping_address: Record<string, string | null> | null;
  [k: string]: unknown;
}

export interface ShipmentRow {
  id: string;
  order_id: string;
  method: 'integrated' | 'seller_arranged' | 'pickup';
  provider: string | null;
  carrier_name: string | null;
  tracking_reference: string | null;
  tracking_url: string | null;
  status: ShipmentStatus;
  confidence: TrackingConfidence;
  dispatch_by: Date | null;
  transit_days_min: number | null;
  transit_days_max: number | null;
  proof_media_id: string | null;
  last_event_at: Date | null;
  delivered_at: Date | null;
  [k: string]: unknown;
}

export const ORDER_COLUMNS = `o.id, o.number, o.shop_id, o.buyer_user_id, o.status, o.payment_status, o.fulfilment_status, o.dispute_status, o.delivery_method,
  o.dispatched_at, o.delivered_at, o.buyer_confirmed_at, o.shipping_address`;

/** Locks the order then its shipment (lock order: orders before shipments/payouts). */
export async function lockOrderAndShipment(tx: Queryable, orderId: string): Promise<{ order: FulfilmentOrder; shipment: ShipmentRow }> {
  const order = await maybeOne<FulfilmentOrder>(tx, `SELECT ${ORDER_COLUMNS} FROM orders o WHERE o.id = $1 FOR UPDATE`, [orderId]);
  if (!order) throw new DomainError('NOT_FOUND', 'Order not found.');
  const shipment = await maybeOne<ShipmentRow>(tx, 'SELECT * FROM shipments WHERE order_id = $1 FOR UPDATE', [orderId]);
  if (!shipment) throw new DomainError('INVALID_STATE', 'This order isn’t ready for delivery yet.');
  return { order, shipment };
}

/** Who the caller is on this order: its buyer, a member of the selling shop, or nobody (NOT_FOUND). */
export async function orderRole(db: Queryable, orderId: string, userId: string): Promise<'buyer' | 'seller'> {
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) throw new DomainError('NOT_FOUND', 'Order not found.');
  const r = await maybeOne<{ buyer_user_id: string; is_member: boolean }>(
    db,
    `SELECT o.buyer_user_id, EXISTS (SELECT 1 FROM shop_members m WHERE m.shop_id = o.shop_id AND m.user_id = $2) AS is_member FROM orders o WHERE o.id = $1`,
    [orderId, userId],
  );
  if (!r) throw new DomainError('NOT_FOUND', 'Order not found.');
  if (r.buyer_user_id === userId) return 'buyer';
  if (r.is_member) return 'seller';
  throw new DomainError('NOT_FOUND', 'Order not found.');
}

export function assertPaidAndActive(order: FulfilmentOrder): void {
  if (order.status !== 'confirmed' || !['paid', 'partially_refunded'].includes(order.payment_status)) {
    throw new DomainError('INVALID_STATE', 'This order isn’t paid or has been cancelled.');
  }
}

export async function addShipmentEvent(
  tx: Queryable,
  args: { shipmentId: string; source: 'courier' | 'seller' | 'buyer' | 'staff' | 'system'; status: string; description?: string; externalId?: string | null; occurredAt: Date; data?: Record<string, unknown> },
): Promise<boolean> {
  const r = await tx.query(
    `INSERT INTO shipment_events (shipment_id, source, status, description, external_id, occurred_at, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (shipment_id, external_id) DO NOTHING`,
    [args.shipmentId, args.source, args.status, args.description ?? '', args.externalId ?? null, args.occurredAt, JSON.stringify(args.data ?? {})],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Moves the order's fulfilment status forward with the state machine (no-op when already there). */
export async function setFulfilmentStatus(tx: Queryable, order: FulfilmentOrder, next: FulfilmentStatus, extra: { dispatchedAt?: Date; deliveredAt?: Date } = {}): Promise<void> {
  if (order.fulfilment_status !== next) assertTransition(FULFILMENT_STATUS, order.fulfilment_status, next, 'fulfilment status');
  await tx.query(
    `UPDATE orders SET fulfilment_status = $2, dispatched_at = coalesce(dispatched_at, $3), delivered_at = coalesce(delivered_at, $4), updated_at = now() WHERE id = $1`,
    [order.id, next, extra.dispatchedAt ?? null, extra.deliveredAt ?? null],
  );
  order.fulfilment_status = next;
}

export function canMoveShipment(from: ShipmentStatus, to: ShipmentStatus): boolean {
  return from === to || (SHIPMENT_STATUS[from] as readonly ShipmentStatus[]).includes(to);
}

export function assertShipmentTransition(from: ShipmentStatus, to: ShipmentStatus): void {
  if (from !== to) assertTransition(SHIPMENT_STATUS, from, to, 'shipment status');
}

/** After any delivery-confidence change: re-evaluate the payout (inside the same transaction). */
export async function afterDeliveryChange(tx: Queryable, ctx: AppContext, orderId: string): Promise<void> {
  await refreshPayoutForOrder(tx, ctx, orderId);
}

export async function notifyOrderParty(
  tx: Queryable,
  order: { id: string; number: string; shop_id: string; buyer_user_id: string },
  to: 'buyer' | 'seller',
  n: { kind: string; title: string; body?: string; dedupeKey: string },
): Promise<void> {
  const userId = to === 'buyer' ? order.buyer_user_id : (await one<{ owner_user_id: string }>(tx, 'SELECT owner_user_id FROM shops WHERE id = $1', [order.shop_id])).owner_user_id;
  await notifyUser(tx, {
    userId,
    topic: 'transactional',
    kind: n.kind,
    title: n.title,
    body: n.body,
    link: to === 'buyer' ? `/orders/${order.id}` : `/sell/orders/${order.id}`,
    dedupeKey: n.dedupeKey,
  });
}

export async function orderEvent(tx: Queryable, orderId: string, kind: string, actor: { kind: 'buyer' | 'seller' | 'staff' | 'system' | 'provider'; userId?: string | null }, data: Record<string, unknown> = {}): Promise<void> {
  await tx.query(`INSERT INTO order_events (order_id, kind, actor_kind, actor_user_id, data) VALUES ($1, $2, $3, $4, $5)`, [orderId, kind, actor.kind, actor.userId ?? null, JSON.stringify(data)]);
}

/** Lets the reviews module know a delivery was confirmed (it opens the review window). */
export async function enqueueDeliveryConfirmed(tx: Queryable, orderId: string): Promise<void> {
  await enqueue(tx, { topic: 'order.delivery_confirmed', aggregateId: orderId, payload: { orderId }, dedupeKey: `order.delivery_confirmed:${orderId}` });
}
