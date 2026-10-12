import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@thrift/database';
import { isDomainError } from '@thrift/domain';
import {
  BELOW_MINIMUM_MESSAGE,
  dispatchOutbox,
  registerAllJobs,
  expireOffers,
  getCheckoutContext,
  getConversation,
  getOfferContext,
  makeOffer,
  markSoldElsewhere,
  respondToOffer,
  shopOffers,
  startCheckout,
  startCheckoutForReservation,
} from '../../src';
import { onOrderPaid, onReservationReleased } from '../../src/offers/jobs';
import { closeTestServices, createListing, createUser, systemCtx, testServices, type TestUser } from '../support';
import { addAddress, ensureCheckoutReferenceData, key, pay, setSetting, stock } from '../checkout/helpers';

afterAll(closeTestServices);
beforeAll(async () => {
  await ensureCheckoutReferenceData();
  await setSetting('max_offers_per_thread_per_day', 6);
});

const naira = (n: number) => String(n);

async function negotiable(opts: { price?: number; min?: number | null; quantity?: number } = {}) {
  return createListing({ saleMode: 'negotiable', priceMinor: (opts.price ?? 10_000) * 100, minOfferMinor: opts.min === null ? null : (opts.min ?? 7_000) * 100, quantity: opts.quantity });
}

async function offer(buyer: TestUser, listingId: string, amount: number, note?: string) {
  return makeOffer(buyer.ctx, { listingId, amount: naira(amount), note, idempotencyKey: key() });
}

async function threadRow(id: string) {
  return (await testServices().pool.query('SELECT * FROM offer_threads WHERE id = $1', [id])).rows[0];
}

describe('making offers', () => {
  it('auto-declines below the private minimum without ever revealing it', async () => {
    const listing = await negotiable({ price: 10_000, min: 7_350 });
    const buyer = await createUser();
    const res = await offer(buyer, listing.id, 7_000);
    expect(res.status).toBe('auto_declined');
    expect(res.message).toBe(BELOW_MINIMUM_MESSAGE);
    const ctx = await getOfferContext(buyer.ctx, listing.id);
    const convo = await getConversation(buyer.ctx, res.conversationId!);
    for (const obj of [res, ctx, convo]) {
      const json = JSON.stringify(obj);
      expect(json).not.toContain('735000');
      expect(json).not.toContain('7,350');
      expect(json).not.toMatch(/min_?offer/i);
    }
    const ok = await offer(buyer, listing.id, 7_500, 'Can collect this week');
    expect(ok.status).toBe('pending');
    expect(convo.offerThreads[0]?.offers[0]?.status).toBe('auto_declined');
  });

  it('validates amounts and modes, one pending offer at a time, and a daily limit per item', async () => {
    const listing = await negotiable({ min: null });
    const buyer = await createUser();
    await expect(offer(buyer, listing.id, 10_001)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(offer(buyer, listing.id, 1_000)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(makeOffer(buyer.ctx, { listingId: listing.id, amount: '', idempotencyKey: key() })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const fixed = await createListing({ saleMode: 'fixed' });
    await expect(offer(buyer, fixed.id, 5_000)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(offer(listing.shop.owner, listing.id, 9_000)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const first = await offer(buyer, listing.id, 8_000);
    await expect(offer(buyer, listing.id, 8_500)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    // Idempotent retries return the same offer.
    const k = key();
    const w = await respondToOffer(buyer.ctx, { offerId: first.offerId, action: 'withdraw', idempotencyKey: k });
    expect(await respondToOffer(buyer.ctx, { offerId: first.offerId, action: 'withdraw', idempotencyKey: k })).toEqual(w);
    await setSetting('max_offers_per_thread_per_day', 2);
    try {
      const again = await offer(buyer, listing.id, 8_200);
      await respondToOffer(buyer.ctx, { offerId: again.offerId, action: 'withdraw' });
      // Withdrawing closed that thread; a new thread starts its own count.
      const t3 = await offer(buyer, listing.id, 8_300);
      await respondToOffer(listing.shop.owner.ctx, { offerId: t3.offerId, action: 'reject' });
      await offer(buyer, listing.id, 8_400);
      const t3b = (await testServices().pool.query(`SELECT id FROM offers WHERE thread_id = $1 AND status = 'pending'`, [t3.threadId])).rows[0];
      await respondToOffer(listing.shop.owner.ctx, { offerId: t3b.id, action: 'reject' });
      await expect(offer(buyer, listing.id, 8_500)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    } finally {
      await setSetting('max_offers_per_thread_per_day', 6);
    }
  });
});

describe('responding to offers', () => {
  it('only the counterparty can accept, counters supersede, and the author can withdraw', async () => {
    const listing = await negotiable();
    const buyer = await createUser();
    const seller = listing.shop.owner;
    const o1 = await offer(buyer, listing.id, 8_000);
    await expect(respondToOffer(buyer.ctx, { offerId: o1.offerId, action: 'accept' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const stranger = await createUser();
    await expect(respondToOffer(stranger.ctx, { offerId: o1.offerId, action: 'accept' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(respondToOffer(seller.ctx, { offerId: o1.offerId, action: 'counter' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const c1 = await respondToOffer(seller.ctx, { offerId: o1.offerId, action: 'counter', counterAmount: '9500', note: 'Lowest I can go' });
    expect(c1.status).toBe('countered');
    const { pool } = testServices();
    expect((await pool.query('SELECT status FROM offers WHERE id = $1', [o1.offerId])).rows[0].status).toBe('countered');
    await expect(respondToOffer(seller.ctx, { offerId: o1.offerId, action: 'accept' })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(respondToOffer(seller.ctx, { offerId: c1.offerId, action: 'accept' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const view = await shopOffers(seller.ctx, { status: 'awaiting_buyer' });
    expect(view.items.find((i) => i.threadId === o1.threadId)?.latest?.amountMinor).toBe(950_000);
    const accepted = await respondToOffer(buyer.ctx, { offerId: c1.offerId, action: 'accept' });
    expect(accepted.status).toBe('accepted');
    expect(accepted.checkoutPath).toBe(`/checkout/new?offer=${o1.threadId}`);
  });

  it('expired offers cannot be accepted and the expiry task is idempotent', async () => {
    const listing = await negotiable();
    const buyer = await createUser();
    const o = await offer(buyer, listing.id, 8_000);
    const later = await createUser();
    void later;
    const { pool } = testServices();
    await pool.query(`UPDATE offers SET expires_at = now() - interval '1 minute' WHERE id = $1`, [o.offerId]);
    await expect(respondToOffer(listing.shop.owner.ctx, { offerId: o.offerId, action: 'accept' })).rejects.toMatchObject({ code: 'EXPIRED' });
    const [a, b] = await Promise.all([expireOffers(systemCtx()), expireOffers(systemCtx())]);
    expect(a.expired + b.expired).toBeGreaterThanOrEqual(1);
    expect((await pool.query('SELECT status FROM offers WHERE id = $1', [o.offerId])).rows[0].status).toBe('expired');
    const msgs = await pool.query(`SELECT count(*)::int AS n FROM messages WHERE offer_id = $1 AND kind = 'system'`, [o.offerId]);
    expect(msgs.rows[0].n).toBe(1);
    await expireOffers(systemCtx());
    expect((await pool.query(`SELECT count(*)::int AS n FROM messages WHERE offer_id = $1 AND kind = 'system'`, [o.offerId])).rows[0].n).toBe(1);
  });

  it('acceptance reserves the piece at the agreed price for the hold period, and checkout uses that price', async () => {
    await setSetting('offer_acceptance_hold_minutes', 60);
    const listing = await negotiable({ price: 10_000 });
    const buyer = await createUser();
    const o = await offer(buyer, listing.id, 8_250);
    const before = Date.now();
    const res = await respondToOffer(listing.shop.owner.ctx, { offerId: o.offerId, action: 'accept' });
    expect(res.status).toBe('accepted');
    const t = await threadRow(o.threadId);
    expect(t).toMatchObject({ status: 'accepted', agreed_price_minor: 825_000 });
    const r = (await testServices().pool.query('SELECT * FROM reservations WHERE id = $1', [t.reservation_id])).rows[0];
    expect(r).toMatchObject({ source: 'offer', source_id: o.threadId, unit_price_minor: 825_000, buyer_user_id: buyer.id, status: 'active' });
    const holdMs = new Date(r.expires_at).getTime() - before;
    expect(holdMs).toBeGreaterThan(59 * 60_000);
    expect(holdMs).toBeLessThan(61 * 60_000);
    expect(await stock(listing.id)).toMatchObject({ quantity_available: 0, quantity_reserved: 1 });
    // The buyer pays the agreed price, not the asking price.
    const addressId = await addAddress(buyer);
    const ctx = await getCheckoutContext(buyer.ctx, { offer: o.threadId });
    expect(ctx.listing.unitPriceMinor).toBe(825_000);
    const started = await startCheckoutForReservation(buyer.ctx, { reservationId: t.reservation_id, addressId, deliveryMethod: 'seller_arranged', idempotencyKey: key() });
    expect(started.totals.itemsTotalMinor).toBe(825_000);
    await pay(systemCtx(), started.orderId);
    const order = (await testServices().pool.query('SELECT source, source_id, status FROM orders WHERE id = $1', [started.orderId])).rows[0];
    expect(order).toMatchObject({ source: 'offer', source_id: o.threadId, status: 'confirmed' });
    // The order.paid event reaches both subscribers (messaging links the conversation, offers completes the thread).
    registerAllJobs();
    for (let i = 0; i < 5 && (await threadRow(o.threadId)).status !== 'completed'; i++) await dispatchOutbox(systemCtx(), 200);
    expect((await threadRow(o.threadId)).status).toBe('completed');
    const convo = await getConversation(buyer.ctx, res.conversationId!);
    expect(convo.order?.id).toBe(started.orderId);
  });
});

describe('T02 contention on one unique piece', () => {
  it('seller acceptance, another buyer’s checkout and “sold elsewhere” race: exactly one wins', async () => {
    for (let round = 0; round < 6; round++) {
      const listing = await negotiable({ min: null });
      const x = await createUser();
      const y = await createUser();
      const yAddress = await addAddress(y);
      const o = await offer(x, listing.id, 9_000);
      const seller = listing.shop.owner;
      const results = await Promise.allSettled([
        respondToOffer(seller.ctx, { offerId: o.offerId, action: 'accept' }),
        startCheckout(y.ctx, { listingId: listing.id, addressId: yAddress, deliveryMethod: 'seller_arranged', idempotencyKey: key() }),
        markSoldElsewhere(seller.ctx, { listingId: listing.id, quantity: 1 }),
      ]);
      const [acc, chk, sold] = results;
      const accepted = acc.status === 'fulfilled' && acc.value.status === 'accepted';
      const checkedOut = chk.status === 'fulfilled';
      const soldElsewhere = sold.status === 'fulfilled';
      expect([accepted, checkedOut, soldElsewhere].filter(Boolean)).toHaveLength(1);
      for (const r of [chk, sold]) {
        if (r.status === 'rejected') expect(isDomainError(r.reason) && ['STOCK_CONFLICT', 'INVALID_STATE'].includes(r.reason.code)).toBe(true);
      }
      if (!accepted) {
        expect(acc.status).toBe('fulfilled');
        if (acc.status === 'fulfilled') expect(acc.value.status).toBe('unavailable');
        expect((await threadRow(o.threadId)).status).toBe('closed_unavailable');
      }
      const s = await stock(listing.id);
      expect(s.quantity_available + s.quantity_reserved + s.quantity_sold + s.quantity_withdrawn).toBe(1);
      expect(s.quantity_available).toBe(0);
    }
  });
});

describe('outbox handlers', () => {
  it('a released offer hold expires the thread once; a paid order completes it and closes other negotiations', async () => {
    const listing = await negotiable({ min: null });
    const x = await createUser();
    const y = await createUser();
    const ox = await offer(x, listing.id, 9_000);
    const oy = await offer(y, listing.id, 8_500);
    await respondToOffer(listing.shop.owner.ctx, { offerId: ox.offerId, action: 'accept' });
    const t = await threadRow(ox.threadId);
    const { pool } = testServices();

    // Hold released (e.g. by the checkout expiry worker) → thread lapses; running twice is harmless.
    const payload = { reservationId: t.reservation_id, source: 'offer', sourceId: ox.threadId, listingId: listing.id };
    await withTransaction(pool, (tx) => onReservationReleased(tx, payload));
    await withTransaction(pool, (tx) => onReservationReleased(tx, payload));
    expect((await threadRow(ox.threadId)).status).toBe('expired');
    const lapsed = await pool.query(`SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND body LIKE 'The hold on this item expired%'`, [t.conversation_id]);
    expect(lapsed.rows[0].n).toBe(1);

    // A paid order completes the thread and closes the other open negotiation on the sold-out piece.
    await pool.query(`UPDATE reservations SET status = 'converted' WHERE id = $1`, [t.reservation_id]);
    await pool.query(`UPDATE inventory_stock SET quantity_reserved = 0, quantity_sold = 1 WHERE listing_id = $1`, [listing.id]);
    const order = await pool.query(
      `INSERT INTO orders (buyer_user_id, shop_id, source, source_id, reservation_id, items_total_minor, total_minor, delivery_method, status, payment_status, paid_at)
       VALUES ($1, $2, 'offer', $3, $4, 900000, 900000, 'seller_arranged', 'confirmed', 'paid', now()) RETURNING id`,
      [x.id, listing.shop.id, ox.threadId, t.reservation_id],
    );
    await pool.query(`INSERT INTO order_items (order_id, listing_id, quantity, unit_price_minor, snapshot) VALUES ($1, $2, 1, 900000, '{}')`, [order.rows[0].id, listing.id]);
    await withTransaction(pool, (tx) => onOrderPaid(tx, { orderId: order.rows[0].id }));
    await withTransaction(pool, (tx) => onOrderPaid(tx, { orderId: order.rows[0].id }));
    expect((await threadRow(ox.threadId)).status).toBe('completed');
    expect((await threadRow(oy.threadId)).status).toBe('closed_unavailable');
    expect((await pool.query('SELECT status FROM offers WHERE id = $1', [oy.offerId])).rows[0].status).toBe('expired');
    const closed = await pool.query(`SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND body LIKE 'This piece has sold%'`, [(await threadRow(oy.threadId)).conversation_id]);
    expect(closed.rows[0].n).toBe(1);
  });
});
