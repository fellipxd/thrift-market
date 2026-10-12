import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@thrift/database';
import { isDomainError } from '@thrift/domain';
import {
  applyVerifiedPayment,
  cancelPendingOrder,
  expireReservations,
  getCheckoutContext,
  getOrderDetail,
  reserveStock,
  retryPayment,
  startCheckout,
  startCheckoutForReservation,
  unbalancedLedgerTransactions,
} from '../../src';
import { closeTestServices, createListing, createShop, createUser, ctxFor, systemCtx, testServices } from '../support';
import { addAddress, ensureCheckoutReferenceData, key, orderRow, pay, setSetting, stock } from './helpers';

afterAll(closeTestServices);
beforeAll(ensureCheckoutReferenceData);

async function buyerWithAddress(state = 'Lagos', city = 'Lagos') {
  const buyer = await createUser({ name: 'Buyer' });
  const addressId = await addAddress(buyer, { state, city });
  return { buyer, addressId };
}

describe('fixed-price checkout', () => {
  it('reserves, records an order snapshot and a payment attempt, then captures a verified payment', async () => {
    const listing = await createListing({ priceMinor: 850_000 });
    const { buyer, addressId } = await buyerWithAddress();
    const started = await startCheckout(buyer.ctx, { listingId: listing.id, addressId, deliveryMethod: 'seller_arranged', idempotencyKey: key() });
    expect(started.authorizationUrl).toContain('/sandbox/pay/');
    expect(started.totals.itemsTotalMinor).toBe(850_000);
    expect(started.totals.totalMinor).toBe(850_000 + started.totals.shippingMinor);
    expect((await stock(listing.id)).quantity_reserved).toBe(1);
    const item = await testServices().pool.query('SELECT snapshot FROM order_items WHERE order_id = $1', [started.orderId]);
    expect(item.rows[0].snapshot.condition).toBe('good');

    await pay(systemCtx(), started.orderId);
    const o = await orderRow(started.orderId);
    expect(o).toMatchObject({ status: 'confirmed', payment_status: 'paid', fulfilment_status: 'awaiting_dispatch', payout_status: 'held' });
    expect(await stock(listing.id)).toMatchObject({ quantity_sold: 1, quantity_reserved: 0 });
    const { pool } = testServices();
    expect((await pool.query('SELECT status FROM shipments WHERE order_id = $1', [started.orderId])).rows[0].status).toBe('pending');
    const payout = await pool.query('SELECT status, amount_minor FROM payouts WHERE order_id = $1', [started.orderId]);
    expect(payout.rows[0]).toMatchObject({ status: 'held', amount_minor: 850_000 + started.totals.shippingMinor });
    expect((await pool.query(`SELECT count(*)::int AS n FROM outbox_events WHERE dedupe_key = $1`, [`order.paid:${started.orderId}`])).rows[0].n).toBe(1);
    expect(await unbalancedLedgerTransactions(pool)).toEqual([]);
  });

  it('T01: 100 concurrent checkouts for one unique piece create exactly one order', async () => {
    const listing = await createListing();
    const buyers = await Promise.all(Array.from({ length: 20 }, () => buyerWithAddress()));
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) => {
        const b = buyers[i % 20]!;
        return startCheckout(b.buyer.ctx, { listingId: listing.id, addressId: b.addressId, deliveryMethod: 'seller_arranged', idempotencyKey: key('t01') }).then(
          () => 'won',
          (err) => (isDomainError(err) && err.code === 'STOCK_CONFLICT' ? 'conflict' : Promise.reject(err)),
        );
      }),
    );
    expect(results.filter((r) => r === 'won')).toHaveLength(1);
    const { pool } = testServices();
    const orders = await pool.query(`SELECT count(*)::int AS n FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE oi.listing_id = $1`, [listing.id]);
    expect(orders.rows[0].n).toBe(1);
    const attempts = await pool.query(`SELECT count(*)::int AS n FROM payment_attempts pa JOIN order_items oi ON oi.order_id = pa.order_id WHERE oi.listing_id = $1`, [listing.id]);
    expect(attempts.rows[0].n).toBe(1);
  });

  it('is idempotent on the request key and rejects own-shop, paused-shop and undeliverable checkouts before reserving', async () => {
    const shop = await createShop({ coverage: 'local' });
    const listing = await createListing({ shop });
    const { buyer, addressId } = await buyerWithAddress('FCT', 'Abuja');
    const k = key();
    const a = await startCheckout(buyer.ctx, { listingId: listing.id, addressId, deliveryMethod: 'seller_arranged', idempotencyKey: k });
    const b = await startCheckout(buyer.ctx, { listingId: listing.id, addressId, deliveryMethod: 'seller_arranged', idempotencyKey: k });
    expect(b.orderId).toBe(a.orderId);

    const ownerAddress = await addAddress(shop.owner);
    const other = await createListing({ shop });
    await expect(startCheckout(shop.owner.ctx, { listingId: other.id, addressId: ownerAddress, deliveryMethod: 'seller_arranged', idempotencyKey: key() })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const far = await buyerWithAddress('Kano', 'Kano');
    await expect(startCheckout(far.buyer.ctx, { listingId: other.id, addressId: far.addressId, deliveryMethod: 'seller_arranged', idempotencyKey: key() })).rejects.toMatchObject({ code: 'NOT_DELIVERABLE' });
    expect((await stock(other.id)).quantity_reserved).toBe(0);

    const paused = await createShop({ status: 'paused' });
    const pl = await createListing({ shop: paused });
    const nearby = await buyerWithAddress('FCT', 'Abuja');
    await expect(startCheckout(nearby.buyer.ctx, { listingId: pl.id, addressId: nearby.addressId, deliveryMethod: 'seller_arranged', idempotencyKey: key() })).rejects.toMatchObject({ code: 'INVALID_STATE' });

    const unverified = await createUser({ verified: false });
    await expect(startCheckout(unverified.ctx, { listingId: pl.id, addressId: nearby.addressId, deliveryMethod: 'seller_arranged', idempotencyKey: key() })).rejects.toMatchObject({ code: 'CONTACT_UNVERIFIED' });
  });

  it('itemises configured fees and computes commission', async () => {
    await setSetting('buyer_fee_flat_minor', 10_000);
    await setSetting('commission_bps', 500);
    try {
      const listing = await createListing({ priceMinor: 1_000_000 });
      const { buyer, addressId } = await buyerWithAddress();
      const s = await startCheckout(buyer.ctx, { listingId: listing.id, addressId, deliveryMethod: 'seller_arranged', idempotencyKey: key() });
      expect(s.totals.buyerFeeMinor).toBe(10_000);
      const o = await orderRow(s.orderId);
      expect(o.commission_minor).toBe(50_000);
      await pay(systemCtx(), s.orderId);
      const payout = await testServices().pool.query('SELECT amount_minor FROM payouts WHERE order_id = $1', [s.orderId]);
      expect(payout.rows[0].amount_minor).toBe(1_000_000 - 50_000 + s.totals.shippingMinor);
      expect(await unbalancedLedgerTransactions(testServices().pool)).toEqual([]);
    } finally {
      await setSetting('buyer_fee_flat_minor', 0);
      await setSetting('commission_bps', 0);
    }
  });

  it('checkout context shows options for the selected address and blocks own-shop purchases', async () => {
    const listing = await createListing();
    const { buyer } = await buyerWithAddress();
    const c = await getCheckoutContext(buyer.ctx, { listing: listing.id });
    expect(c.blocked).toBeNull();
    expect(c.options.map((o) => o.method)).toContain('seller_arranged');
    const own = await getCheckoutContext(listing.shop.owner.ctx, { listing: listing.id });
    expect(own.blocked).toMatch(/own shop/);
  });
});

describe('reservations from offers and auctions', () => {
  it('uses the agreed price from the reservation', async () => {
    const listing = await createListing({ priceMinor: 900_000, saleMode: 'negotiable' });
    const { buyer, addressId } = await buyerWithAddress();
    const r = await withTransaction(testServices().pool, (tx) =>
      reserveStock(tx, { listingId: listing.id, buyerUserId: buyer.id, quantity: 1, source: 'offer', sourceId: null, unitPriceMinor: 700_000, expiresAt: new Date(Date.now() + 3_600_000) }),
    );
    const s = await startCheckoutForReservation(buyer.ctx, { reservationId: r.id, addressId, deliveryMethod: 'seller_arranged', idempotencyKey: key() });
    expect(s.totals.itemsTotalMinor).toBe(700_000);
    const other = await createUser();
    const otherAddress = await addAddress(other);
    await expect(startCheckoutForReservation(other.ctx, { reservationId: r.id, addressId: otherAddress, deliveryMethod: 'seller_arranged', idempotencyKey: key() })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('T03: expiry races payment', () => {
  it('a payment that succeeds before expiry is captured', async () => {
    const listing = await createListing();
    const { buyer, addressId } = await buyerWithAddress();
    const s = await startCheckout(buyer.ctx, { listingId: listing.id, addressId, deliveryMethod: 'seller_arranged', idempotencyKey: key() });
    await pay(systemCtx(), s.orderId);
    const later = () => new Date(Date.now() + 3 * 3_600_000);
    await expireReservations(systemCtx(later));
    expect((await orderRow(s.orderId)).status).toBe('confirmed');
  });

  it('pending payments get a grace period; after release a late success re-allocates the still-free unit', async () => {
    const listing = await createListing();
    const { buyer, addressId } = await buyerWithAddress();
    const s = await startCheckout(buyer.ctx, { listingId: listing.id, addressId, deliveryMethod: 'seller_arranged', idempotencyKey: key() });
    const t1 = () => new Date(Date.now() + 11 * 60_000);
    await expireReservations(systemCtx(t1));
    const resv = await testServices().pool.query('SELECT status FROM reservations WHERE id = (SELECT reservation_id FROM orders WHERE id = $1)', [s.orderId]);
    expect(resv.rows[0].status).toBe('payment_pending');
    const t2 = () => new Date(Date.now() + 60 * 60_000);
    await expireReservations(systemCtx(t2));
    expect((await orderRow(s.orderId)).status).toBe('cancelled');
    expect((await stock(listing.id)).quantity_available).toBe(1);
    await pay(systemCtx(), s.orderId);
    const o = await orderRow(s.orderId);
    expect(o).toMatchObject({ status: 'confirmed', payment_status: 'paid' });
    expect(await stock(listing.id)).toMatchObject({ quantity_sold: 1, quantity_available: 0 });
  });

  it('a late success after the unit went to another buyer is refunded, never sold twice', async () => {
    const listing = await createListing();
    const a = await buyerWithAddress();
    const s = await startCheckout(a.buyer.ctx, { listingId: listing.id, addressId: a.addressId, deliveryMethod: 'seller_arranged', idempotencyKey: key() });
    await pay(systemCtx(), s.orderId, 'abandoned');
    const later = () => new Date(Date.now() + 15 * 60_000);
    await expireReservations(systemCtx(later));
    expect((await orderRow(s.orderId)).status).toBe('cancelled');
    const b = await buyerWithAddress();
    const sb = await startCheckout(b.buyer.ctx, { listingId: listing.id, addressId: b.addressId, deliveryMethod: 'seller_arranged', idempotencyKey: key() });
    // Buyer A's provider page eventually completes (late) — simulate the provider record flipping to success.
    const { pool } = testServices();
    const ref = (await pool.query('SELECT reference FROM payment_attempts WHERE order_id = $1', [s.orderId])).rows[0].reference;
    await pool.query(`UPDATE sandbox_payments SET status = 'succeeded', paid_at = now() WHERE reference = $1`, [ref]);
    const r = await applyVerifiedPayment(systemCtx(), ref);
    expect(r.outcome).toBe('late_refunded');
    const refund = await pool.query(`SELECT reason, status FROM refunds WHERE order_id = $1`, [s.orderId]);
    expect(refund.rows[0]).toMatchObject({ reason: 'late_payment_after_release', status: 'approved' });
    expect(await stock(listing.id)).toMatchObject({ quantity_reserved: 1, quantity_sold: 0 });
    await pay(systemCtx(), sb.orderId);
    expect(await stock(listing.id)).toMatchObject({ quantity_sold: 1, quantity_reserved: 0 });
    expect(await unbalancedLedgerTransactions(pool)).toEqual([]);
  });

  it('buyers can retry an unpaid order while the hold lasts, and cancel it', async () => {
    const listing = await createListing();
    const { buyer, addressId } = await buyerWithAddress();
    const s = await startCheckout(buyer.ctx, { listingId: listing.id, addressId, deliveryMethod: 'seller_arranged', idempotencyKey: key() });
    await pay(systemCtx(), s.orderId, 'failed');
    const again = await retryPayment(buyer.ctx, { orderId: s.orderId });
    expect(again.authorizationUrl).toContain('/sandbox/pay/');
    const attempts = await testServices().pool.query('SELECT status FROM payment_attempts WHERE order_id = $1 ORDER BY created_at', [s.orderId]);
    expect(attempts.rows.map((x) => x.status)).toEqual(['failed', 'pending']);
    expect(await cancelPendingOrder(buyer.ctx, { orderId: s.orderId })).toEqual({ status: 'cancelled' });
    expect((await stock(listing.id)).quantity_available).toBe(1);
  });
});

describe('order access', () => {
  it('only the buyer and the selling shop can read an order; the seller sees the address after payment', async () => {
    const listing = await createListing();
    const { buyer, addressId } = await buyerWithAddress();
    const s = await startCheckout(buyer.ctx, { listingId: listing.id, addressId, deliveryMethod: 'seller_arranged', idempotencyKey: key() });
    const stranger = await createUser();
    await expect(getOrderDetail(stranger.ctx, s.orderId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const sellerView = await getOrderDetail(listing.shop.owner.ctx, s.orderId);
    expect(sellerView.shippingAddress).toBeNull();
    await pay(systemCtx(), s.orderId);
    const afterPay = await getOrderDetail(listing.shop.owner.ctx, s.orderId);
    expect(afterPay.shippingAddress?.line1).toBe('12 Test Street');
    expect(JSON.stringify(await getOrderDetail(buyer.ctx, s.orderId))).not.toContain('commissionMinor":5');
  });
});

export { ctxFor };
