import { markDispatchedInput, orderIdInput, staffVerifyDeliveryInput } from '@thrift/contracts';
import { DomainError, type TrackingConfidence } from '@thrift/domain';
import { maybeOne, one, withTransaction } from '@thrift/database';
import { recordAudit } from '../core/audit';
import { requireStaff, requireUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { parseInput } from '../core/validation';
import {
  addShipmentEvent,
  afterDeliveryChange,
  assertPaidAndActive,
  assertShipmentTransition,
  enqueueDeliveryConfirmed,
  lockOrderAndShipment,
  notifyOrderParty,
  orderEvent,
  orderRole,
  setFulfilmentStatus,
  type FulfilmentOrder,
  type ShipmentRow,
} from './shared';

export interface DispatchResult {
  orderId: string;
  shipmentStatus: string;
  trackingReference: string | null;
  /** Integrated bookings whose provider call failed are retried by a worker task. */
  bookingPending: boolean;
}

/**
 * Seller dispatches a paid order. Integrated delivery books the courier (the provider call happens outside the
 * transaction after the intent is recorded, so a crash or timeout is retried, never double-booked). Seller-arranged
 * delivery records the rider/carrier and an optional proof photo — tracking confidence is "reported by seller".
 * Pickup marks the item ready for collection.
 */
export async function markDispatched(ctx: AppContext, raw: unknown): Promise<DispatchResult> {
  const user = requireUser(ctx);
  const input = parseInput(markDispatchedInput, raw);
  if ((await orderRole(ctx.pool, input.orderId, user.userId)) !== 'seller') throw new DomainError('NOT_FOUND', 'Order not found.');
  const method = (await one<{ delivery_method: string }>(ctx.pool, 'SELECT delivery_method FROM orders WHERE id = $1', [input.orderId])).delivery_method;
  if (method === 'integrated') return dispatchIntegrated(ctx, input.orderId, user.userId);
  if (input.proofMediaId) {
    const media = await maybeOne(ctx.pool, `SELECT 1 AS ok FROM media_assets WHERE id = $1 AND owner_user_id = $2 AND purpose = 'delivery_proof' AND status = 'ready'`, [
      input.proofMediaId,
      user.userId,
    ]);
    if (!media) throw new DomainError('VALIDATION_FAILED', 'Upload the proof photo again.', { fieldErrors: { proofMediaId: 'Upload the proof photo again.' } });
  }
  if (method === 'seller_arranged' && !input.carrierName) {
    throw new DomainError('VALIDATION_FAILED', 'Tell the buyer who is delivering it.', { fieldErrors: { carrierName: 'Enter the rider or delivery company.' } });
  }
  return withTransaction(ctx.pool, async (tx) => {
    const { order, shipment } = await lockOrderAndShipment(tx, input.orderId);
    assertPaidAndActive(order);
    if (order.fulfilment_status !== 'awaiting_dispatch') throw new DomainError('INVALID_STATE', 'This order has already been dispatched.');
    const now = ctx.now();
    if (method === 'pickup') {
      assertShipmentTransition(shipment.status, 'booked');
      await tx.query(`UPDATE shipments SET status = 'booked', confidence = 'seller_reported', carrier_name = 'Collection from seller', last_event_at = $2, updated_at = now() WHERE id = $1`, [
        shipment.id,
        now,
      ]);
      await addShipmentEvent(tx, { shipmentId: shipment.id, source: 'seller', status: 'ready_for_pickup', description: input.note ?? 'Ready for collection', occurredAt: now });
      await setFulfilmentStatus(tx, order, 'dispatched', { dispatchedAt: now });
      await notifyOrderParty(tx, order, 'buyer', {
        kind: 'order_ready_for_pickup',
        title: `Order ${order.number} is ready for collection`,
        body: 'Arrange collection with the seller in your order chat. Confirm in the app once you have it.',
        dedupeKey: `ready-for-pickup:${order.id}`,
      });
    } else {
      assertShipmentTransition(shipment.status, 'in_transit');
      await tx.query(
        `UPDATE shipments SET status = 'in_transit', confidence = 'seller_reported', carrier_name = $2, tracking_reference = $3, proof_media_id = $4, last_event_at = $5, updated_at = now() WHERE id = $1`,
        [shipment.id, input.carrierName, input.trackingReference ?? null, input.proofMediaId ?? null, now],
      );
      await addShipmentEvent(tx, {
        shipmentId: shipment.id,
        source: 'seller',
        status: 'in_transit',
        description: [`Sent with ${input.carrierName}`, input.trackingReference && `ref ${input.trackingReference}`, input.note].filter(Boolean).join(' · '),
        occurredAt: now,
        data: { proofMediaId: input.proofMediaId ?? null },
      });
      await setFulfilmentStatus(tx, order, 'in_transit', { dispatchedAt: now });
      await notifyOrderParty(tx, order, 'buyer', {
        kind: 'order_dispatched',
        title: `Order ${order.number} is on its way`,
        body: `The seller sent it with ${input.carrierName}. Tracking for seller-arranged delivery is reported by the seller.`,
        dedupeKey: `dispatched:${order.id}`,
      });
    }
    await orderEvent(tx, order.id, 'dispatched', { kind: 'seller', userId: user.userId }, { method, late: shipment.dispatch_by ? now > new Date(shipment.dispatch_by) : false });
    const s = await one<{ status: string; tracking_reference: string | null }>(tx, 'SELECT status, tracking_reference FROM shipments WHERE id = $1', [shipment.id]);
    return { orderId: order.id, shipmentStatus: s.status, trackingReference: s.tracking_reference, bookingPending: false };
  });
}

async function dispatchIntegrated(ctx: AppContext, orderId: string, userId: string): Promise<DispatchResult> {
  // 1. Record the booking intent (idempotent per order).
  const intent = await withTransaction(ctx.pool, async (tx) => {
    const { order, shipment } = await lockOrderAndShipment(tx, orderId);
    assertPaidAndActive(order);
    if (shipment.tracking_reference) return { done: true as const, order, shipment };
    if (order.fulfilment_status !== 'awaiting_dispatch') throw new DomainError('INVALID_STATE', 'This order has already been dispatched.');
    await addShipmentEvent(tx, { shipmentId: shipment.id, source: 'seller', status: 'booking_requested', externalId: `booking:${order.id}`, occurredAt: ctx.now(), data: { by: userId } });
    await tx.query(`UPDATE shipments SET provider = $2, updated_at = now() WHERE id = $1`, [shipment.id, ctx.providers.courier.name]);
    return { done: false as const, order, shipment };
  });
  if (intent.done) return { orderId, shipmentStatus: intent.shipment.status, trackingReference: intent.shipment.tracking_reference, bookingPending: false };
  const booked = await bookCourier(ctx, orderId, userId);
  return { orderId, shipmentStatus: booked ? 'booked' : 'pending', trackingReference: booked, bookingPending: !booked };
}

/**
 * Books the courier for an order whose booking intent is recorded. The provider call is outside any transaction;
 * the result is applied only if the shipment is still unbooked. Returns the tracking reference, or null on failure.
 */
export async function bookCourier(ctx: AppContext, orderId: string, actorUserId: string | null): Promise<string | null> {
  const info = await one<{
    number: string; shipping_address: Record<string, string | null>; shop_name: string; shop_city: string; shop_state: string; quote_minor: number | null;
    transit_days_min: number | null; transit_days_max: number | null; weight: number | null;
  }>(
    ctx.pool,
    `SELECT o.number, o.shipping_address, s.name AS shop_name, s.city AS shop_city, s.state AS shop_state, sh.quote_minor, sh.transit_days_min, sh.transit_days_max,
            (SELECT max(l.weight_grams) FROM order_items oi JOIN listings l ON l.id = oi.listing_id WHERE oi.order_id = o.id) AS weight
       FROM orders o JOIN shops s ON s.id = o.shop_id JOIN shipments sh ON sh.order_id = o.id WHERE o.id = $1`,
    [orderId],
  );
  const a = info.shipping_address ?? {};
  let booking;
  try {
    booking = await ctx.providers.courier.book({
      orderNumber: info.number,
      quote: { available: true, feeMinor: info.quote_minor ?? 0, transitDaysMin: info.transit_days_min ?? 1, transitDaysMax: info.transit_days_max ?? 7, serviceName: ctx.providers.courier.name },
      origin: { name: info.shop_name, phone: '', city: info.shop_city, state: info.shop_state, addressLine: '' },
      destination: { name: a.recipientName ?? '', phone: a.phone ?? '', city: a.city ?? '', state: a.state ?? '', addressLine: [a.line1, a.line2, a.area].filter(Boolean).join(', ') },
      weightGrams: info.weight ?? 800,
    });
  } catch (err) {
    await ctx.pool.query(
      `INSERT INTO shipment_events (shipment_id, source, status, description, occurred_at, data)
       SELECT id, 'system', 'booking_failed', 'Courier booking will be retried automatically', now(), $2 FROM shipments WHERE order_id = $1`,
      [orderId, JSON.stringify({ error: String((err as Error).message).slice(0, 300) })],
    );
    return null;
  }
  return withTransaction(ctx.pool, async (tx) => {
    const { order, shipment } = await lockOrderAndShipment(tx, orderId);
    if (shipment.tracking_reference) return shipment.tracking_reference;
    if (order.status !== 'confirmed' || order.fulfilment_status !== 'awaiting_dispatch') return null;
    const now = ctx.now();
    assertShipmentTransition(shipment.status, 'booked');
    await tx.query(
      `UPDATE shipments SET status = 'booked', tracking_reference = $2, tracking_url = $3, carrier_name = $4, last_event_at = $5, updated_at = now() WHERE id = $1`,
      [shipment.id, booking.trackingReference, booking.trackingUrl, booking.carrierName, now],
    );
    await addShipmentEvent(tx, { shipmentId: shipment.id, source: 'system', status: 'booked', description: `Booked with ${booking.carrierName}`, externalId: `booked:${booking.trackingReference}`, occurredAt: now });
    await setFulfilmentStatus(tx, order, 'dispatched', { dispatchedAt: now });
    await orderEvent(tx, order.id, 'dispatched', { kind: actorUserId ? 'seller' : 'system', userId: actorUserId }, { method: 'integrated', late: shipment.dispatch_by ? now > new Date(shipment.dispatch_by) : false });
    await notifyOrderParty(tx, order, 'buyer', {
      kind: 'order_dispatched',
      title: `Order ${order.number} has been booked with ${booking.carrierName}`,
      body: `Tracking reference ${booking.trackingReference}. You’ll see courier milestones on your order.`,
      dedupeKey: `dispatched:${order.id}`,
    });
    return booking.trackingReference;
  });
}

/** Seller says a seller-arranged delivery arrived. Confidence stays "reported by seller": the payout stays held. */
export async function markDeliveredBySeller(ctx: AppContext, raw: unknown): Promise<{ orderId: string }> {
  const user = requireUser(ctx);
  const input = parseInput(orderIdInput, raw);
  if ((await orderRole(ctx.pool, input.orderId, user.userId)) !== 'seller') throw new DomainError('NOT_FOUND', 'Order not found.');
  return withTransaction(ctx.pool, async (tx) => {
    const { order, shipment } = await lockOrderAndShipment(tx, input.orderId);
    assertPaidAndActive(order);
    if (order.delivery_method === 'integrated') throw new DomainError('INVALID_STATE', 'Courier deliveries are confirmed by the courier’s tracking.');
    if (shipment.status === 'delivered') return { orderId: order.id };
    if (!['in_transit', 'booked', 'exception'].includes(shipment.status)) throw new DomainError('INVALID_STATE', 'Mark the order as dispatched first.');
    const now = ctx.now();
    assertShipmentTransition(shipment.status === 'booked' ? 'picked_up' : shipment.status, 'delivered');
    await tx.query(`UPDATE shipments SET status = 'delivered', delivered_at = $2, last_event_at = $2, updated_at = now() WHERE id = $1`, [shipment.id, now]);
    await addShipmentEvent(tx, { shipmentId: shipment.id, source: 'seller', status: 'delivered', description: 'Seller reported the item as delivered', occurredAt: now });
    await setFulfilmentStatus(tx, order, 'delivered', { deliveredAt: now });
    await afterDeliveryChange(tx, ctx, order.id);
    await notifyOrderParty(tx, order, 'buyer', {
      kind: 'confirm_delivery',
      title: `Did order ${order.number} arrive?`,
      body: 'The seller says it was delivered. Confirm once you have it, or report a problem.',
      dedupeKey: `seller-delivered:${order.id}`,
    });
    return { orderId: order.id };
  });
}

const CONFIDENCE_RANK: Record<TrackingConfidence, number> = { none: 0, seller_reported: 1, courier_verified: 2, buyer_confirmed: 3, staff_verified: 3 };

async function markDelivered(
  ctx: AppContext,
  order: FulfilmentOrder,
  shipment: ShipmentRow,
  confidence: TrackingConfidence,
  tx: Parameters<typeof addShipmentEvent>[0],
  event: { source: 'buyer' | 'staff'; description: string },
): Promise<void> {
  const now = ctx.now();
  const keepConfidence = CONFIDENCE_RANK[shipment.confidence] > CONFIDENCE_RANK[confidence] ? shipment.confidence : confidence;
  await tx.query(
    `UPDATE shipments SET status = 'delivered', confidence = $2, delivered_at = coalesce(delivered_at, $3), last_event_at = $3, updated_at = now() WHERE id = $1`,
    [shipment.id, keepConfidence, now],
  );
  await addShipmentEvent(tx, { shipmentId: shipment.id, source: event.source, status: 'delivered', description: event.description, occurredAt: now });
  if (order.fulfilment_status !== 'delivered') {
    // A buyer can confirm a pickup or a delivery the seller never marked dispatched.
    if (order.fulfilment_status === 'awaiting_dispatch') await setFulfilmentStatus(tx, order, 'delivered', { dispatchedAt: now, deliveredAt: now });
    else await setFulfilmentStatus(tx, order, 'delivered', { deliveredAt: now });
  }
}

/** Buyer confirms they have the item: the strongest delivery confidence. Starts the review window. */
export async function confirmReceipt(ctx: AppContext, raw: unknown): Promise<{ orderId: string; payoutStatus: string | null }> {
  const user = requireUser(ctx);
  const input = parseInput(orderIdInput, raw);
  if ((await orderRole(ctx.pool, input.orderId, user.userId)) !== 'buyer') throw new DomainError('NOT_FOUND', 'Order not found.');
  return withTransaction(ctx.pool, async (tx) => {
    const { order, shipment } = await lockOrderAndShipment(tx, input.orderId);
    assertPaidAndActive(order);
    if (order.buyer_confirmed_at) return { orderId: order.id, payoutStatus: null };
    if (order.dispute_status === 'open') throw new DomainError('INVALID_STATE', 'You have an open dispute on this order. Withdraw it first if everything is fine.');
    if (order.fulfilment_status === 'awaiting_dispatch' && order.delivery_method !== 'pickup') {
      throw new DomainError('INVALID_STATE', 'The seller hasn’t dispatched this order yet.');
    }
    if (['returned', 'cancelled'].includes(order.fulfilment_status)) throw new DomainError('INVALID_STATE', 'This order can’t be confirmed.');
    await markDelivered(ctx, order, shipment, 'buyer_confirmed', tx, { source: 'buyer', description: 'Buyer confirmed they received the item' });
    await tx.query(`UPDATE orders SET buyer_confirmed_at = $2, updated_at = now() WHERE id = $1`, [order.id, ctx.now()]);
    await orderEvent(tx, order.id, 'buyer_confirmed', { kind: 'buyer', userId: user.userId });
    await enqueueDeliveryConfirmed(tx, order.id);
    await afterDeliveryChange(tx, ctx, order.id);
    await notifyOrderParty(tx, order, 'seller', {
      kind: 'delivery_confirmed',
      title: `The buyer confirmed delivery of order ${order.number}`,
      body: 'Your payout will be released according to the payout schedule.',
      dedupeKey: `buyer-confirmed:${order.id}`,
    });
    const payout = await maybeOne<{ status: string }>(tx, 'SELECT status FROM payouts WHERE order_id = $1', [order.id]);
    return { orderId: order.id, payoutStatus: payout?.status ?? null };
  });
}

/** Support verifies a delivery with evidence (e.g. after a long silence on a seller-reported delivery). Audited. */
export async function staffVerifyDelivery(ctx: AppContext, raw: unknown): Promise<{ orderId: string }> {
  const staff = requireStaff(ctx, 'support', 'trust_safety', 'admin');
  const input = parseInput(staffVerifyDeliveryInput, raw);
  return withTransaction(ctx.pool, async (tx) => {
    const { order, shipment } = await lockOrderAndShipment(tx, input.orderId);
    assertPaidAndActive(order);
    if (order.dispute_status === 'open') throw new DomainError('INVALID_STATE', 'Resolve the open dispute instead.');
    if (order.fulfilment_status === 'awaiting_dispatch') throw new DomainError('INVALID_STATE', 'This order hasn’t been dispatched.');
    await markDelivered(ctx, order, shipment, 'staff_verified', tx, { source: 'staff', description: 'Delivery verified by support' });
    await orderEvent(tx, order.id, 'delivery_staff_verified', { kind: 'staff', userId: staff.userId }, { reason: input.reason });
    await recordAudit(tx, ctx, { action: 'delivery.staff_verified', targetKind: 'order', targetId: order.id, reason: input.reason });
    await afterDeliveryChange(tx, ctx, order.id);
    return { orderId: order.id };
  });
}
