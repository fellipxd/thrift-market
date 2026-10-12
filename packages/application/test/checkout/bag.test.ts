import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isDomainError } from '@thrift/domain';
import {
  applyVerifiedPayment,
  cancelOrderBySeller,
  cancelPendingOrder,
  expireReservations,
  getBag,
  getBagCheckoutContext,
  getOrderDetail,
  removeFromBag,
  retryPayment,
  saveToBag,
  startBagCheckout,
  startCheckout,
  unbalancedLedgerTransactions,
} from '../../src';
import { closeTestServices, createListing, createShop, createUser, systemCtx, testServices, type TestUser } from '../support';
import { addAddress, ensureCheckoutReferenceData, key, orderRow, pay, setSetting, stock } from './helpers';

afterAll(closeTestServices);
beforeAll(ensureCheckoutReferenceData);

async function buyerWithAddress(state = 'Lagos', city = 'Lagos') {
  const buyer = await createUser({ name: 'Buyer' });
  const addressId = await addAddress(buyer, { state, city });
  return { buyer, addressId };
}

const count = async (sql: string, params: unknown[]): Promise<number> => Number((await testServices().pool.query(sql, params)).rows[0].n);

async function bagCheckout(buyer: TestUser, addressId: string, shopId: string, items: { id: string; price: number; quantity?: number }[], idempotencyKey = key('bag')) {
  return startBagCheckout(buyer.ctx, {
    shopId,
    items: items.map((i) => ({ listingId: i.id, quantity: i.quantity ?? 1, expectedUnitPriceMinor: i.price })),
    addressId,
    deliveryMethod: 'seller_arranged',
    idempotencyKey,
  });
}

describe('bag (interest list, never a hold)', () => {
  it('saves pieces you could buy now, groups them by shop and reserves nothing', async () => {
    const shop = await createShop();
    const a = await createListing({ shop, title: 'Linen shirt' });
    const b = await createListing({ shop, quantity: 3, priceMinor: 300_000, title: 'Plain tee' });
    const other = await createListing({ title: 'Denim jacket' });
    const { buyer } = await buyerWithAddress();
    await saveToBag(buyer.ctx, { listingId: a.id });
    expect(await saveToBag(buyer.ctx, { listingId: b.id, quantity: 5 })).toMatchObject({ quantity: 3 });
    await saveToBag(buyer.ctx, { listingId: other.id });
    expect(await stock(a.id)).toMatchObject({ quantity_available: 1, quantity_reserved: 0 });
    const bag = await getBag(buyer.ctx);
    expect(bag.count).toBe(3);
    expect(bag.groups).toHaveLength(2);
    const g = bag.groups.find((x) => x.shop.id === shop.id)!;
    expect(g.items.map((i) => i.title).sort()).toEqual(['Linen shirt', 'Plain tee']);
    expect(g.subtotalMinor).toBe(850_000 + 3 * 300_000);
    expect(g.blocked).toBeNull();

    await removeFromBag(buyer.ctx, { listingId: other.id });
    expect((await getBag(buyer.ctx)).count).toBe(2);
  });

  it('refuses own-shop, auction, sold and over-limit pieces, and shows a piece that sold after it was saved', async () => {
    const shop = await createShop();
    const mine = await createListing({ shop });
    await expect(saveToBag(shop.owner.ctx, { listingId: mine.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const { buyer } = await buyerWithAddress();
    const auction = await createListing({ saleMode: 'auction' });
    await expect(saveToBag(buyer.ctx, { listingId: auction.id })).rejects.toMatchObject({ code: 'INVALID_STATE' });

    const piece = await createListing();
    await saveToBag(buyer.ctx, { listingId: piece.id });
    const rival = await buyerWithAddress();
    const s = await startCheckout(rival.buyer.ctx, { listingId: piece.id, addressId: rival.addressId, deliveryMethod: 'seller_arranged', idempotencyKey: key() });
    expect((await getBag(buyer.ctx)).groups[0]!.items[0]!.state).toBe('reserved');
    await pay(systemCtx(), s.orderId);
    const g = (await getBag(buyer.ctx)).groups[0]!;
    expect(g.items[0]!.state).toBe('sold');
    expect(g.checkoutable).toHaveLength(0);
    expect(g.blocked).toMatch(/None of these pieces/);
    const fresh = await createUser();
    await expect(saveToBag(fresh.ctx, { listingId: piece.id })).rejects.toMatchObject({ code: 'STOCK_CONFLICT' });

    await setSetting('max_bag_items', 1);
    try {
      const x = await createListing();
      const y = await createListing();
      await saveToBag(fresh.ctx, { listingId: x.id });
      await saveToBag(fresh.ctx, { listingId: x.id, quantity: 1 });
      await expect(saveToBag(fresh.ctx, { listingId: y.id })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    } finally {
      await setSetting('max_bag_items', 20);
    }
  });
});

describe('same-seller bag checkout (doc 06 checkout group)', () => {
  it('holds every piece in one order with one delivery fee, and payment sells them all and clears them from the bag', async () => {
    const shop = await createShop();
    const a = await createListing({ shop, priceMinor: 850_000 });
    const b = await createListing({ shop, priceMinor: 300_000, quantity: 3 });
    const { buyer, addressId } = await buyerWithAddress();
    await saveToBag(buyer.ctx, { listingId: a.id });
    await saveToBag(buyer.ctx, { listingId: b.id, quantity: 2 });

    const ctx = await getBagCheckoutContext(buyer.ctx, { shop: shop.id });
    expect(ctx.items).toHaveLength(2);
    const quoted = ctx.options.find((o) => o.method === 'seller_arranged')!;
    expect(quoted.totals.itemsTotalMinor).toBe(1_450_000);

    const started = await bagCheckout(buyer, addressId, shop.id, [
      { id: a.id, price: 850_000 },
      { id: b.id, price: 300_000, quantity: 2 },
    ]);
    expect(started.totals.itemsTotalMinor).toBe(1_450_000);
    expect(started.totals.shippingMinor).toBe(quoted.feeMinor);
    expect(started.totals.totalMinor).toBe(quoted.totals.totalMinor);
    expect(await stock(a.id)).toMatchObject({ quantity_reserved: 1, quantity_available: 0 });
    expect(await stock(b.id)).toMatchObject({ quantity_reserved: 2, quantity_available: 1 });
    const { pool } = testServices();
    const items = (await pool.query('SELECT reservation_id, shipping_share_minor FROM order_items WHERE order_id = $1', [started.orderId])).rows;
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.reservation_id)).toBe(true);
    expect(items.reduce((sum, i) => sum + Number(i.shipping_share_minor), 0)).toBe(started.totals.shippingMinor);
    expect((await orderRow(started.orderId)).reservation_id).toBeNull();
    expect((await getBag(buyer.ctx)).groups[0]!.items.every((i) => i.state === 'held_for_you')).toBe(true);

    await pay(systemCtx(), started.orderId);
    expect(await orderRow(started.orderId)).toMatchObject({ status: 'confirmed', payment_status: 'paid' });
    expect(await stock(a.id)).toMatchObject({ quantity_sold: 1, quantity_reserved: 0 });
    expect(await stock(b.id)).toMatchObject({ quantity_sold: 2, quantity_reserved: 0, quantity_available: 1 });
    expect((await getBag(buyer.ctx)).count).toBe(0);
    const payout = (await pool.query('SELECT amount_minor FROM payouts WHERE order_id = $1', [started.orderId])).rows[0];
    expect(Number(payout.amount_minor)).toBe(1_450_000 + started.totals.shippingMinor);
    const detail = await getOrderDetail(buyer.ctx, started.orderId);
    expect(detail.items).toHaveLength(2);
    expect(await unbalancedLedgerTransactions(pool)).toEqual([]);
  });

  it('T01: if the second piece is unavailable, neither piece stays held and no order exists', async () => {
    const shop = await createShop();
    // Pieces are held in listing-id order, so make the unavailable piece the one held second: the first hold has
    // already been taken inside the transaction when the conflict is found, and must not survive it.
    const byId = (p: { id: string }, q: { id: string }) => (p.id < q.id ? -1 : 1);
    const [first, second] = [await createListing({ shop, title: 'Piece one' }), await createListing({ shop, title: 'Piece two' })].sort(byId);
    const rival = await buyerWithAddress();
    await startCheckout(rival.buyer.ctx, { listingId: second!.id, addressId: rival.addressId, deliveryMethod: 'seller_arranged', idempotencyKey: key() });
    const { buyer, addressId } = await buyerWithAddress();
    const err = await bagCheckout(buyer, addressId, shop.id, [
      { id: first!.id, price: 850_000 },
      { id: second!.id, price: 850_000 },
    ]).catch((e) => e);
    expect(isDomainError(err) && err.code).toBe('STOCK_CONFLICT');
    const secondTitle = (await testServices().pool.query('SELECT title FROM listings WHERE id = $1', [second!.id])).rows[0].title;
    expect(err.message).toContain(`“${secondTitle}” was just reserved by another buyer`);
    expect(await stock(first!.id)).toMatchObject({ quantity_available: 1, quantity_reserved: 0 });

    // Same when the later piece is short of the quantity asked for (the inventory authority refuses that hold).
    const [early, late] = [await createListing({ shop }), await createListing({ shop })].sort(byId);
    await testServices().pool.query(`UPDATE listings SET quantity_mode = 'equivalent' WHERE id = $1`, [late!.id]);
    const short = await bagCheckout(buyer, addressId, shop.id, [
      { id: early!.id, price: 850_000 },
      { id: late!.id, price: 850_000, quantity: 2 },
    ]).catch((e) => e);
    expect(isDomainError(short) && short.code).toBe('STOCK_CONFLICT');
    expect(short.message).toContain('doesn’t have that many left');
    expect(await stock(early!.id)).toMatchObject({ quantity_available: 1, quantity_reserved: 0 });
    expect(await count(`SELECT count(*) AS n FROM reservations WHERE buyer_user_id = $1`, [buyer.id])).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM orders WHERE buyer_user_id = $1`, [buyer.id])).toBe(0);
  });

  it('refuses a changed price, a cross-seller list and too many holds before holding anything', async () => {
    const shop = await createShop();
    const a = await createListing({ shop, priceMinor: 500_000 });
    const b = await createListing({ shop, priceMinor: 400_000 });
    const elsewhere = await createListing();
    const { buyer, addressId } = await buyerWithAddress();
    await testServices().pool.query('UPDATE listings SET price_minor = 450_000 WHERE id = $1', [b.id]);
    const changed = await bagCheckout(buyer, addressId, shop.id, [
      { id: a.id, price: 500_000 },
      { id: b.id, price: 400_000 },
    ]).catch((e) => e);
    expect(isDomainError(changed) && changed.code).toBe('CONFLICT');
    expect(changed.message).toMatch(/changed from ₦4,000 to ₦4,500/);
    expect(await stock(a.id)).toMatchObject({ quantity_reserved: 0 });

    await expect(
      bagCheckout(buyer, addressId, shop.id, [
        { id: a.id, price: 500_000 },
        { id: elsewhere.id, price: 850_000 },
      ]),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await setSetting('max_active_reservations_per_buyer', 1);
    try {
      await expect(
        bagCheckout(buyer, addressId, shop.id, [
          { id: a.id, price: 500_000 },
          { id: b.id, price: 450_000 },
        ]),
      ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
      expect((await getBagCheckoutContext(buyer.ctx, { shop: shop.id }).catch((e) => e)).code).toBe('NOT_FOUND');
    } finally {
      await setSetting('max_active_reservations_per_buyer', 5);
    }
    expect(await count(`SELECT count(*) AS n FROM reservations WHERE buyer_user_id = $1`, [buyer.id])).toBe(0);
    await expect(bagCheckout(shop.owner, addressId, shop.id, [{ id: a.id, price: 500_000 }])).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('is idempotent on the request key', async () => {
    const shop = await createShop();
    const a = await createListing({ shop });
    const b = await createListing({ shop });
    const { buyer, addressId } = await buyerWithAddress();
    const k = key('bag');
    const items = [
      { id: a.id, price: 850_000 },
      { id: b.id, price: 850_000 },
    ];
    const first = await bagCheckout(buyer, addressId, shop.id, items, k);
    const again = await bagCheckout(buyer, addressId, shop.id, items, k);
    expect(again.orderId).toBe(first.orderId);
    expect(await count(`SELECT count(*) AS n FROM reservations WHERE buyer_user_id = $1`, [buyer.id])).toBe(2);
  });

  it('treats listing and shop ids case-insensitively (lock order is by uuid value)', async () => {
    const shop = await createShop();
    const a = await createListing({ shop });
    const b = await createListing({ shop });
    const { buyer, addressId } = await buyerWithAddress();
    const s = await bagCheckout(buyer, addressId, shop.id.toUpperCase(), [
      { id: b.id.toUpperCase(), price: 850_000 },
      { id: a.id, price: 850_000 },
    ]);
    expect(await count(`SELECT count(*) AS n FROM order_items WHERE order_id = $1`, [s.orderId])).toBe(2);
    expect((await orderRow(s.orderId)).shop_id).toBe(shop.id);
  });

  it('T01: concurrent overlapping bag checkouts never hold a piece twice and never leave a partial group', async () => {
    const shop = await createShop();
    const [a, b, c] = await Promise.all([createListing({ shop }), createListing({ shop }), createListing({ shop })]);
    const buyers = await Promise.all(Array.from({ length: 12 }, () => buyerWithAddress()));
    // Half want [A, B] (listed in either order), half want [B, C]: sorted stock locks mean no deadlock either way.
    const results = await Promise.all(
      buyers.map((x, i) => {
        const pick = i % 2 === 0 ? (i % 4 === 0 ? [a, b] : [b, a]) : [b, c];
        return bagCheckout(x.buyer, x.addressId, shop.id, pick.map((l) => ({ id: l.id, price: 850_000 }))).then(
          (r) => r.orderId,
          (err) => (isDomainError(err) && err.code === 'STOCK_CONFLICT' ? null : Promise.reject(err)),
        );
      }),
    );
    const winners = results.filter((r): r is string => !!r);
    expect(winners).toHaveLength(1);
    const { pool } = testServices();
    for (const l of [a, b, c]) {
      expect(await count(`SELECT count(*) AS n FROM reservations WHERE listing_id = $1 AND status = 'active'`, [l.id])).toBeLessThanOrEqual(1);
    }
    expect(await count(`SELECT count(*) AS n FROM order_items WHERE order_id = $1`, [winners[0]])).toBe(2);
    const held = (await pool.query(`SELECT count(*)::int AS n FROM reservations WHERE listing_id = ANY($1::uuid[]) AND status = 'active'`, [[a.id, b.id, c.id]])).rows[0].n;
    expect(held).toBe(2);
  });

  it('expires, cancels and retries the group as a unit', async () => {
    const shop = await createShop();
    const a = await createListing({ shop });
    const b = await createListing({ shop });
    const { buyer, addressId } = await buyerWithAddress();
    const items = [
      { id: a.id, price: 850_000 },
      { id: b.id, price: 850_000 },
    ];

    const s1 = await bagCheckout(buyer, addressId, shop.id, items);
    await pay(systemCtx(), s1.orderId, 'failed');
    const retried = await retryPayment(buyer.ctx, { orderId: s1.orderId });
    expect(retried.orderId).toBe(s1.orderId);
    expect(await count(`SELECT count(*) AS n FROM payment_attempts WHERE order_id = $1`, [s1.orderId])).toBe(2);
    expect(await cancelPendingOrder(buyer.ctx, { orderId: s1.orderId })).toEqual({ status: 'cancelled' });
    expect(await stock(a.id)).toMatchObject({ quantity_available: 1, quantity_reserved: 0 });
    expect(await stock(b.id)).toMatchObject({ quantity_available: 1, quantity_reserved: 0 });

    const s2 = await bagCheckout(buyer, addressId, shop.id, items);
    await pay(systemCtx(), s2.orderId, 'abandoned');
    const later = () => new Date(Date.now() + 15 * 60_000);
    await expireReservations(systemCtx(later));
    expect((await orderRow(s2.orderId)).status).toBe('cancelled');
    expect(await stock(a.id)).toMatchObject({ quantity_available: 1, quantity_reserved: 0 });
    expect(await stock(b.id)).toMatchObject({ quantity_available: 1, quantity_reserved: 0 });
    expect(await count(`SELECT count(*) AS n FROM order_events WHERE order_id = $1 AND kind = 'hold_expired'`, [s2.orderId])).toBe(1);
    await expect(retryPayment(buyer.ctx, { orderId: s2.orderId })).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('a late payment re-allocates only if every piece is still free; otherwise nothing is sold and it is refunded in full', async () => {
    const shop = await createShop();
    const a = await createListing({ shop });
    const b = await createListing({ shop });
    const { buyer, addressId } = await buyerWithAddress();
    const items = [
      { id: a.id, price: 850_000 },
      { id: b.id, price: 850_000 },
    ];
    const { pool } = testServices();
    const flip = async (orderId: string) => {
      const ref = (await pool.query('SELECT reference FROM payment_attempts WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1', [orderId])).rows[0].reference;
      await pool.query(`UPDATE sandbox_payments SET status = 'succeeded', paid_at = now() WHERE reference = $1`, [ref]);
      return applyVerifiedPayment(systemCtx(), ref);
    };
    const later = () => new Date(Date.now() + 15 * 60_000);

    // Both pieces still free after expiry: the late payment buys both.
    const s1 = await bagCheckout(buyer, addressId, shop.id, items);
    await pay(systemCtx(), s1.orderId, 'abandoned');
    await expireReservations(systemCtx(later));
    expect((await flip(s1.orderId)).outcome).toBe('late_reallocated');
    expect(await stock(a.id)).toMatchObject({ quantity_sold: 1 });
    expect(await stock(b.id)).toMatchObject({ quantity_sold: 1 });

    // One piece went to someone else in the meantime: no piece is sold to the late payer.
    const c = await createListing({ shop });
    const d = await createListing({ shop });
    const s2 = await bagCheckout(buyer, addressId, shop.id, [
      { id: c.id, price: 850_000 },
      { id: d.id, price: 850_000 },
    ]);
    await pay(systemCtx(), s2.orderId, 'abandoned');
    await expireReservations(systemCtx(later));
    const rival = await buyerWithAddress();
    const rs = await startCheckout(rival.buyer.ctx, { listingId: d.id, addressId: rival.addressId, deliveryMethod: 'seller_arranged', idempotencyKey: key() });
    expect((await flip(s2.orderId)).outcome).toBe('late_refunded');
    expect(await stock(c.id)).toMatchObject({ quantity_available: 1, quantity_sold: 0, quantity_reserved: 0 });
    expect(await stock(d.id)).toMatchObject({ quantity_reserved: 1, quantity_sold: 0 });
    const refund = (await pool.query(`SELECT reason, amount_minor FROM refunds WHERE order_id = $1`, [s2.orderId])).rows[0];
    expect(refund.reason).toBe('late_payment_after_release');
    expect(Number(refund.amount_minor)).toBe(s2.totals.totalMinor);
    await pay(systemCtx(), rs.orderId);
    expect(await stock(d.id)).toMatchObject({ quantity_sold: 1 });
    expect(await unbalancedLedgerTransactions(pool)).toEqual([]);
  });

  it('a seller cancelling a paid bag order returns every piece to stock', async () => {
    const shop = await createShop();
    const a = await createListing({ shop });
    const b = await createListing({ shop, quantity: 2, priceMinor: 300_000 });
    const { buyer, addressId } = await buyerWithAddress();
    const s = await bagCheckout(buyer, addressId, shop.id, [
      { id: a.id, price: 850_000 },
      { id: b.id, price: 300_000, quantity: 2 },
    ]);
    await pay(systemCtx(), s.orderId);
    await cancelOrderBySeller(shop.owner.ctx, { orderId: s.orderId, reason: 'Found damage while packing', restock: true });
    expect(await stock(a.id)).toMatchObject({ quantity_sold: 0, quantity_available: 1 });
    expect(await stock(b.id)).toMatchObject({ quantity_sold: 0, quantity_available: 2 });
    const refund = (await testServices().pool.query(`SELECT amount_minor FROM refunds WHERE order_id = $1`, [s.orderId])).rows[0];
    expect(Number(refund.amount_minor)).toBe(s.totals.totalMinor);
  });
});
