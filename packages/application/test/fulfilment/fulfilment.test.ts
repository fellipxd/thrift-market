import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COURIER_SIGNATURE_HEADER, signCourierPayload, type CourierProvider } from '@thrift/providers';
import {
  confirmReceipt,
  deliveriesNeedingReview,
  deliveryFollowups,
  dispatchReminders,
  ingestCourierWebhook,
  markDeliveredBySeller,
  markDispatched,
  orderTracking,
  retryCourierBookings,
  simulateCourierEvent,
  staffVerifyDelivery,
  startCheckout,
} from '../../src';
import type { AppContext } from '../../src/core/context';
import { closeTestServices, createListing, createUser, systemCtx, testServices } from '../support';
import { addAddress, ensureCheckoutReferenceData, key } from '../checkout/helpers';
import { insertMediaFor, paidOrder, row } from './helpers';

afterAll(closeTestServices);
beforeAll(ensureCheckoutReferenceData);

const pool = () => testServices().pool;

function courierBody(events: { id: string; reference: string; status: string; occurred_at: string; description?: string }[]) {
  const body = JSON.stringify({ events });
  return { body, headers: { [COURIER_SIGNATURE_HEADER]: signCourierPayload(testServices().config.appSecret, body) } };
}

describe('dispatch', () => {
  it('only the seller of a paid order can dispatch; seller-arranged needs a carrier and stays seller-reported', async () => {
    const { orderId, buyer, seller } = await paidOrder('seller_arranged');
    const stranger = await createUser();
    await expect(markDispatched(buyer.ctx, { orderId, carrierName: 'X' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(markDispatched(stranger.ctx, { orderId, carrierName: 'X' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(markDispatched(seller.ctx, { orderId })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const otherProof = await insertMediaFor(buyer.id, 'delivery_proof');
    await expect(markDispatched(seller.ctx, { orderId, carrierName: 'GIG', proofMediaId: otherProof })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const proof = await insertMediaFor(seller.id, 'delivery_proof');
    const res = await markDispatched(seller.ctx, { orderId, carrierName: 'Kwik rider', trackingReference: 'KW-123', proofMediaId: proof });
    expect(res.shipmentStatus).toBe('in_transit');
    expect(await row('shipments', orderId)).toMatchObject({ status: 'in_transit', confidence: 'seller_reported', carrier_name: 'Kwik rider', tracking_reference: 'KW-123' });
    expect(await row('orders', orderId)).toMatchObject({ fulfilment_status: 'in_transit' });
    await expect(markDispatched(seller.ctx, { orderId, carrierName: 'Again' })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const t = await orderTracking(buyer.ctx, orderId);
    expect(t?.confidenceLabel).toBe('Reported by seller');
    expect(t?.proofPhoto?.url).toMatch(/sig=/);
    await expect(orderTracking(stranger.ctx, orderId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const support = await createUser({ roles: ['support'] });
    expect((await orderTracking(support.ctx, orderId))?.viewer).toBe('staff');
  });

  it('unpaid orders cannot be dispatched', async () => {
    const listing = await createListing();
    const buyer = await createUser();
    const addressId = await addAddress(buyer);
    const started = await startCheckout(buyer.ctx, { listingId: listing.id, addressId, deliveryMethod: 'seller_arranged', idempotencyKey: key() });
    await expect(markDispatched(listing.shop.owner.ctx, { orderId: started.orderId, carrierName: 'X' })).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});

describe('T12 delivery confidence and payouts', () => {
  it('seller-reported delivery keeps the payout held; buyer confirmation makes it eligible', async () => {
    const { orderId, buyer, seller } = await paidOrder('seller_arranged');
    await markDispatched(seller.ctx, { orderId, carrierName: 'Rider' });
    await markDeliveredBySeller(seller.ctx, { orderId });
    expect(await row('shipments', orderId)).toMatchObject({ status: 'delivered', confidence: 'seller_reported' });
    expect(await row('payouts', orderId)).toMatchObject({ status: 'held', hold_reason: 'awaiting_buyer_confirmation' });
    await expect(confirmReceipt(seller.ctx, { orderId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const res = await confirmReceipt(buyer.ctx, { orderId });
    expect(res.payoutStatus).toBe('eligible');
    expect(await row('shipments', orderId)).toMatchObject({ confidence: 'buyer_confirmed' });
    expect((await row('orders', orderId)).buyer_confirmed_at).not.toBeNull();
    expect((await pool().query(`SELECT count(*)::int AS n FROM outbox_events WHERE dedupe_key = $1`, [`order.delivery_confirmed:${orderId}`])).rows[0].n).toBe(1);
    // Idempotent.
    expect((await confirmReceipt(buyer.ctx, { orderId })).payoutStatus).toBeNull();
  });

  it('integrated: booking, signed courier milestones (deduplicated, never regressing), courier-verified delivery', async () => {
    const { orderId, buyer, seller } = await paidOrder('integrated');
    const res = await markDispatched(seller.ctx, { orderId });
    expect(res.shipmentStatus).toBe('booked');
    const order = await row('orders', orderId);
    expect(res.trackingReference).toBe(`SBX-${order.number}`);
    expect(order.fulfilment_status).toBe('dispatched');
    const ref = res.trackingReference!;

    // Forged signature: nothing applied.
    const forged = JSON.stringify({ events: [{ id: 'evil', reference: ref, status: 'delivered', occurred_at: new Date().toISOString() }] });
    expect((await ingestCourierWebhook(systemCtx(), forged, { [COURIER_SIGNATURE_HEADER]: 'abcd' })).accepted).toBe(false);
    expect((await row('shipments', orderId)).status).toBe('booked');

    const t0 = Date.now();
    const picked = courierBody([{ id: `e1-${ref}`, reference: ref, status: 'picked_up', occurred_at: new Date(t0 + 1_000).toISOString() }]);
    expect(await ingestCourierWebhook(systemCtx(), picked.body, picked.headers)).toMatchObject({ applied: 1 });
    expect(await ingestCourierWebhook(systemCtx(), picked.body, picked.headers)).toMatchObject({ applied: 0, duplicates: 1 });
    expect(await row('shipments', orderId)).toMatchObject({ status: 'picked_up', confidence: 'courier_verified' });
    expect((await row('orders', orderId)).fulfilment_status).toBe('in_transit');

    const delivered = courierBody([{ id: `e3-${ref}`, reference: ref, status: 'delivered', occurred_at: new Date(t0 + 3_000).toISOString() }]);
    await ingestCourierWebhook(systemCtx(), delivered.body, delivered.headers);
    // An older event arriving late is recorded but does not regress the status.
    const late = courierBody([{ id: `e2-${ref}`, reference: ref, status: 'in_transit', occurred_at: new Date(t0 + 2_000).toISOString() }]);
    expect(await ingestCourierWebhook(systemCtx(), late.body, late.headers)).toMatchObject({ outOfOrder: 1 });
    expect(await row('shipments', orderId)).toMatchObject({ status: 'delivered', confidence: 'courier_verified' });
    expect((await row('orders', orderId)).fulfilment_status).toBe('delivered');
    const payout = await row('payouts', orderId);
    expect(payout.status).toBe('eligible');
    expect(new Date(payout.eligible_at).getTime()).toBeGreaterThan(Date.now());
    const tracking = await orderTracking(buyer.ctx, orderId);
    expect(tracking?.events.map((e) => e.status)).toEqual(['booked', 'picked_up', 'in_transit', 'delivered']);
    expect(tracking?.events.find((e) => e.status === 'in_transit')?.sourceLabel).toBe('Courier');
  });

  it('a courier exception is visible to both parties; the sandbox console uses the same ingestion', async () => {
    const { orderId, seller, buyer } = await paidOrder('integrated');
    const { trackingReference } = await markDispatched(seller.ctx, { orderId });
    await simulateCourierEvent(systemCtx(), { reference: trackingReference!, status: 'exception', description: 'Address could not be found' });
    expect(await row('shipments', orderId)).toMatchObject({ status: 'exception' });
    expect((await row('orders', orderId)).fulfilment_status).toBe('delivery_exception');
    expect((await orderTracking(buyer.ctx, orderId))?.exception).toBe(true);
    const n = await pool().query(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'delivery_exception' AND user_id IN ($1, $2)`, [buyer.id, seller.id]);
    expect(n.rows[0].n).toBe(2);
  });

  it('a failed courier booking is retried by the worker and never double-books', async () => {
    const { orderId, seller } = await paidOrder('integrated');
    const real = seller.ctx.providers.courier;
    const failing: CourierProvider = Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
      book: async () => {
        throw new Error('courier timeout');
      },
    });
    const ctx: AppContext = { ...seller.ctx, providers: { ...seller.ctx.providers, courier: failing } };
    const res = await markDispatched(ctx, { orderId });
    expect(res).toMatchObject({ bookingPending: true, trackingReference: null });
    expect((await row('orders', orderId)).fulfilment_status).toBe('awaiting_dispatch');
    await pool().query(`UPDATE shipment_events SET received_at = now() - interval '5 minutes' WHERE status = 'booking_requested' AND shipment_id = (SELECT id FROM shipments WHERE order_id = $1)`, [orderId]);
    await Promise.all([retryCourierBookings(systemCtx()), retryCourierBookings(systemCtx())]);
    expect(await row('shipments', orderId)).toMatchObject({ status: 'booked' });
    expect((await pool().query(`SELECT count(*)::int AS n FROM shipment_events WHERE status = 'booked' AND shipment_id = (SELECT id FROM shipments WHERE order_id = $1)`, [orderId])).rows[0].n).toBe(1);
  });

  it('pickup: ready for collection, then the buyer confirms collection', async () => {
    const { orderId, seller, buyer } = await paidOrder('pickup');
    await markDispatched(seller.ctx, { orderId });
    expect(await row('shipments', orderId)).toMatchObject({ status: 'booked', confidence: 'seller_reported' });
    await confirmReceipt(buyer.ctx, { orderId });
    expect(await row('shipments', orderId)).toMatchObject({ status: 'delivered', confidence: 'buyer_confirmed' });
  });
});

describe('follow-ups', () => {
  it('late dispatch is recorded and the seller reminded once', async () => {
    const { orderId } = await paidOrder('seller_arranged');
    await pool().query(`UPDATE shipments SET dispatch_by = now() - interval '1 hour' WHERE order_id = $1`, [orderId]);
    await dispatchReminders(systemCtx());
    await dispatchReminders(systemCtx());
    expect((await pool().query(`SELECT count(*)::int AS n FROM order_events WHERE order_id = $1 AND kind = 'dispatch_late'`, [orderId])).rows[0].n).toBe(1);
  });

  it('long-unconfirmed seller-reported deliveries are reminded, then reviewed and verified by support (never auto-released)', async () => {
    const { orderId, seller } = await paidOrder('seller_arranged');
    await markDispatched(seller.ctx, { orderId, carrierName: 'Rider' });
    await markDeliveredBySeller(seller.ctx, { orderId });
    await pool().query(`UPDATE shipments SET delivered_at = now() - interval '11 days' WHERE order_id = $1`, [orderId]);
    await deliveryFollowups(systemCtx());
    const kinds = (await pool().query(`SELECT kind FROM order_events WHERE order_id = $1`, [orderId])).rows.map((r) => r.kind);
    expect(kinds).toContain('delivery_confirmation_reminder');
    expect(kinds).toContain('delivery_review_needed');
    expect((await row('payouts', orderId)).status).toBe('held');
    const support = await createUser({ roles: ['support'] });
    expect((await deliveriesNeedingReview(support.ctx)).map((d) => d.orderId)).toContain(orderId);
    await expect(staffVerifyDelivery(seller.ctx, { orderId, reason: 'Rider photo at the gate' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await staffVerifyDelivery(support.ctx, { orderId, reason: 'Rider proof photo and call log checked' });
    expect(await row('shipments', orderId)).toMatchObject({ confidence: 'staff_verified' });
    expect((await row('payouts', orderId)).status).toBe('eligible');
    expect((await pool().query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'delivery.staff_verified' AND target_id = $1`, [orderId])).rows[0].n).toBe(1);
  });
});
