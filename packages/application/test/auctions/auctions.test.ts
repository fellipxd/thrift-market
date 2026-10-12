import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@thrift/database';
import { isDomainError } from '@thrift/domain';
import {
  acceptSecondChance,
  actOnReport,
  pauseShop,
  submitReport,
  cancelAuction,
  createAuction,
  declineSecondChance,
  enqueueReservationReleased,
  finalizeAuction,
  getAuctionView,
  getCheckoutContext,
  listAuctions,
  offerSecondChance,
  onAuctionOrderPaid,
  onAuctionReservationReleased,
  placeBid,
  relistAuction,
  releaseReservation,
  shopAuctions,
  startCheckoutForReservation,
  strikeCount,
} from '../../src';
import { finalizeHooks } from '../../src/auctions/lifecycle';
import { closeTestServices, createListing, createShop, createUser, ctxFor, systemCtx, testServices, type TestShop, type TestUser } from '../support';
import { insertMedia } from '../catalogue/helpers';
import { addAddress, ensureCheckoutReferenceData, key, pay, stock } from '../checkout/helpers';

afterAll(closeTestServices);
beforeAll(ensureCheckoutReferenceData);
afterEach(() => {
  finalizeHooks.afterReserve = undefined;
});

const HOUR = 3_600_000;
const { pool } = { get pool() { return testServices().pool; } };

/** A publish-ready unique draft (photos, condition, size) in the given shop. */
async function auctionDraft(shop?: TestShop) {
  const listing = await createListing({ shop, status: 'draft', saleMode: 'auction', title: `Vintage bag ${key()}` });
  for (const [i, role] of ['front', 'back'].entries()) {
    const m = await insertMedia(listing.shop.owner.id);
    await pool.query(`INSERT INTO listing_media (listing_id, media_id, position, role) VALUES ($1, $2, $3, $4)`, [listing.id, m, i, role]);
  }
  return listing;
}

async function liveAuction(opts: { minutes?: number; opening?: number; increment?: number; shop?: TestShop } = {}) {
  const listing = await auctionDraft(opts.shop);
  const endsAt = new Date(Date.now() + (opts.minutes ?? 60) * 60_000).toISOString();
  const res = await createAuction(listing.shop.owner.ctx, {
    listingId: listing.id,
    startsAt: 'now',
    endsAt,
    openingPrice: String(opts.opening ?? 5_000),
    increment: String(opts.increment ?? 500),
  });
  return { listing, auctionId: res.auctionId, seller: listing.shop.owner, endsAt: new Date(res.endsAt) };
}

async function bidder(name = 'Bidder', now?: () => Date): Promise<TestUser> {
  const u = await createUser({ name, now });
  await addAddress(u);
  return u;
}

function at(user: TestUser, when: Date) {
  return ctxFor(user.actor, () => when);
}

async function auctionRow(id: string) {
  return (await pool.query('SELECT * FROM auctions WHERE id = $1', [id])).rows[0];
}

const bid = (u: TestUser | ReturnType<typeof at>, auctionId: string, amount: number, k = key()) =>
  placeBid('ctx' in u ? u.ctx : u, { auctionId, amount: String(amount), idempotencyKey: k });

describe('scheduling', () => {
  it('schedules a ready draft, rejects published/incomplete pieces and other shops, and cancels before bids', async () => {
    const draft = await auctionDraft();
    const owner = draft.shop.owner;
    const start = new Date(Date.now() + 2 * HOUR);
    await expect(
      createAuction((await createUser()).ctx, { listingId: draft.id, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + HOUR).toISOString(), openingPrice: '5000', increment: '500' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      createAuction(owner.ctx, { listingId: draft.id, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 5 * 60_000).toISOString(), openingPrice: '5000', increment: '500' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const res = await createAuction(owner.ctx, { listingId: draft.id, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + HOUR).toISOString(), openingPrice: '5000', increment: '500' });
    expect(res.status).toBe('scheduled');
    expect((await pool.query('SELECT status FROM listings WHERE id = $1', [draft.id])).rows[0].status).toBe('scheduled');
    expect((await pool.query(`SELECT count(*)::int AS n FROM outbox_events WHERE dedupe_key = $1`, [`auction.scheduled:${res.auctionId}`])).rows[0].n).toBe(1);

    const published = await createListing({ saleMode: 'fixed' });
    await expect(
      createAuction(published.shop.owner.ctx, { listingId: published.id, startsAt: 'now', endsAt: new Date(Date.now() + HOUR).toISOString(), openingPrice: '5000', increment: '500' }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const bare = await createListing({ status: 'draft', saleMode: 'auction' });
    await expect(
      createAuction(bare.shop.owner.ctx, { listingId: bare.id, startsAt: 'now', endsAt: new Date(Date.now() + HOUR).toISOString(), openingPrice: '5000', increment: '500' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await cancelAuction(owner.ctx, { auctionId: res.auctionId, reason: 'Found a stain' });
    expect(await auctionRow(res.auctionId)).toMatchObject({ status: 'cancelled' });
    expect(await stock(draft.id)).toMatchObject({ quantity_available: 0, quantity_withdrawn: 1 });
    expect((await pool.query('SELECT status FROM listings WHERE id = $1', [draft.id])).rows[0].status).toBe('draft');
  });

  it('parses seller-entered WAT times (UTC+1) and cannot be cancelled after a bid', async () => {
    const draft = await auctionDraft();
    const d = new Date(Date.now() + 26 * HOUR);
    const pad = (n: number) => String(n).padStart(2, '0');
    const wat = new Date(d.getTime() + HOUR); // the same instant on a WAT wall clock
    const local = `${wat.getUTCFullYear()}-${pad(wat.getUTCMonth() + 1)}-${pad(wat.getUTCDate())}T${pad(wat.getUTCHours())}:${pad(wat.getUTCMinutes())}`;
    const endLocalDate = new Date(wat.getTime() + 2 * HOUR);
    const endLocal = `${endLocalDate.getUTCFullYear()}-${pad(endLocalDate.getUTCMonth() + 1)}-${pad(endLocalDate.getUTCDate())}T${pad(endLocalDate.getUTCHours())}:${pad(endLocalDate.getUTCMinutes())}`;
    const res = await createAuction(draft.shop.owner.ctx, { listingId: draft.id, startsAt: local, endsAt: endLocal, openingPrice: '5,000', increment: '500' });
    expect(Math.abs(new Date(res.startsAt).getTime() - Math.floor(d.getTime() / 60_000) * 60_000)).toBeLessThan(60_000);

    const { auctionId, seller } = await liveAuction();
    await bid(await bidder(), auctionId, 5_000);
    await expect(cancelAuction(seller.ctx, { auctionId, reason: 'Changed my mind' })).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});

describe('bidding', () => {
  it('validates opening price, increments, eligibility and delivery; retries are idempotent', async () => {
    const { auctionId, seller, listing } = await liveAuction({ opening: 5_000, increment: 500 });
    const a = await bidder('Ada');
    const b = await bidder('Bayo');
    await expect(bid(a, auctionId, 4_999)).rejects.toMatchObject({ code: 'CONFLICT' });
    const k = key();
    const first = await bid(a, auctionId, 5_000, k);
    expect(first).toMatchObject({ seq: 1, replayed: false });
    expect(await bid(a, auctionId, 5_000, k)).toMatchObject({ bidId: first.bidId, replayed: true });
    await expect(bid(a, auctionId, 6_000)).rejects.toMatchObject({ code: 'CONFLICT' }); // already leading
    await expect(bid(b, auctionId, 5_400)).rejects.toMatchObject({ code: 'CONFLICT', details: { minimumNextBidMinor: 550_000 } });
    await bid(b, auctionId, 5_500);
    await expect(bid(seller, auctionId, 9_000)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const unverified = await createUser({ verified: false });
    await expect(bid(unverified, auctionId, 9_000)).rejects.toMatchObject({ code: 'CONTACT_UNVERIFIED' });
    const noAddress = await createUser();
    await expect(bid(noAddress, auctionId, 9_000)).rejects.toMatchObject({ code: 'NOT_DELIVERABLE' });
    const local = await createShop({ coverage: 'local' });
    await pool.query('UPDATE delivery_coverage SET offers_pickup = false WHERE shop_id = $1', [local.id]);
    const localAuction = await liveAuction({ shop: local });
    const farAway = await createUser();
    await addAddress(farAway, { state: 'Kano', city: 'Kano' });
    await expect(bid(farAway, localAuction.auctionId, 9_000)).rejects.toMatchObject({ code: 'NOT_DELIVERABLE' });
    const row = await auctionRow(auctionId);
    expect(row).toMatchObject({ bid_count: 2, seq: 2, current_bid_minor: 550_000, current_bidder_user_id: b.id });
    const q = (await pool.query('SELECT destination_state, delivery_quote FROM bids WHERE id = $1', [first.bidId])).rows[0];
    expect(q.destination_state).toBe('Lagos');
    expect(q.delivery_quote.options.length).toBeGreaterThan(0);
    void listing;
  });

  it('T05: 50 concurrent bids from 10 bidders leave a gap-free, strictly increasing history', async () => {
    const { auctionId } = await liveAuction({ opening: 1_000, increment: 100 });
    const bidders = await Promise.all(Array.from({ length: 10 }, (_, i) => bidder(`B${i}`)));
    const amounts = Array.from({ length: 50 }, (_, i) => 1_000 + ((i * 37) % 40) * 100);
    const results = await Promise.allSettled(amounts.map((amt, i) => bid(bidders[i % 10]!, auctionId, amt)));
    for (const r of results) if (r.status === 'rejected') expect(isDomainError(r.reason) && r.reason.code).toBe('CONFLICT');
    const accepted = results.filter((r) => r.status === 'fulfilled').length;
    const rows = (await pool.query('SELECT seq, amount_minor, bidder_user_id FROM bids WHERE auction_id = $1 ORDER BY seq', [auctionId])).rows;
    expect(rows.length).toBe(accepted);
    rows.forEach((r, i) => {
      expect(r.seq).toBe(i + 1);
      if (i > 0) {
        expect(Number(r.amount_minor)).toBeGreaterThanOrEqual(Number(rows[i - 1].amount_minor) + 10_000);
        expect(r.bidder_user_id).not.toBe(rows[i - 1].bidder_user_id);
      }
    });
    const a = await auctionRow(auctionId);
    expect(a.bid_count).toBe(accepted);
    expect(a.seq).toBe(accepted);
    expect(Number(a.current_bid_minor)).toBe(Math.max(...rows.map((r) => Number(r.amount_minor))));
  });

  it('T05: equal concurrent bids → exactly one accepted', async () => {
    const { auctionId } = await liveAuction({ opening: 2_000, increment: 200 });
    const bidders = await Promise.all(Array.from({ length: 6 }, (_, i) => bidder(`E${i}`)));
    const results = await Promise.allSettled(bidders.map((u) => bid(u, auctionId, 2_000)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('anti-sniping: a late bid extends the end, never beyond the cap; stale client clocks do not matter', async () => {
    const { auctionId, endsAt } = await liveAuction({ minutes: 30 });
    const original = endsAt.getTime();
    const users = await Promise.all(Array.from({ length: 8 }, (_, i) => bidder(`S${i}`)));
    // 60s before the end → new end = bid time + 120s.
    const r1 = await bid(at(users[0]!, new Date(original - 60_000)), auctionId, 5_000);
    expect(r1.extended).toBe(true);
    expect(new Date(r1.endsAt).getTime()).toBe(original + 60_000);
    // A bid well before the window doesn't extend.
    const early = await bid(at(users[1]!, new Date(original - 20 * 60_000)), auctionId, 5_500);
    expect(early.extended).toBe(false);
    // Keep sniping: the end never passes original + 600s.
    let end = new Date(r1.endsAt).getTime();
    for (let i = 2; i < 8; i++) {
      const r = await bid(at(users[i]!, new Date(end - 1_000)), auctionId, 6_000 + i * 500);
      end = new Date(r.endsAt).getTime();
      expect(end).toBeLessThanOrEqual(original + 600_000);
    }
    expect(end).toBe(original + 600_000);
    // After the (extended) end, server time rejects bids whatever the client thought.
    await expect(bid(at(users[0]!, new Date(end + 1)), auctionId, 20_000)).rejects.toMatchObject({ code: 'EXPIRED' });
  });
});

describe('finalising', () => {
  it('T05: bids at the close boundary race the finaliser — a bid is never accepted after finalisation', async () => {
    for (let round = 0; round < 5; round++) {
      const { auctionId, endsAt } = await liveAuction({ minutes: 20 });
      const lead = await bidder('Lead');
      await bid(lead, auctionId, 5_000);
      const late = await bidder('Late');
      const [b, f] = await Promise.allSettled([
        bid(at(late, new Date(endsAt.getTime() - 1_000)), auctionId, 6_000),
        finalizeAuction(systemCtx(() => new Date(endsAt.getTime())), auctionId),
      ]);
      const a = await auctionRow(auctionId);
      if (b.status === 'fulfilled') {
        // The bid won the lock: the auction extended and the finaliser (if it ran after) skipped.
        expect(new Date(a.ends_at).getTime()).toBeGreaterThan(endsAt.getTime());
        expect(f.status === 'fulfilled' && f.value).toBe('not_due');
        expect(a.status).toBe('live');
      } else {
        expect(isDomainError(b.reason) && b.reason.code).toBe('EXPIRED');
        expect(a.status).toBe('awaiting_payment');
        expect(a.winner_user_id).toBe(lead.id);
        expect(a.bid_count).toBe(1);
      }
    }
  });

  it('T05: five concurrent finalisers produce one winner and one reservation', async () => {
    const { auctionId, endsAt, listing } = await liveAuction();
    const a = await bidder('A');
    const b = await bidder('B');
    await bid(a, auctionId, 5_000);
    await bid(b, auctionId, 6_000);
    const later = systemCtx(() => new Date(endsAt.getTime() + 1_000));
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => finalizeAuction(later, auctionId)));
    expect(outcomes.filter((o) => o === 'winner_allocated')).toHaveLength(1);
    const row = await auctionRow(auctionId);
    expect(row).toMatchObject({ status: 'awaiting_payment', winner_user_id: b.id });
    const res = await pool.query(`SELECT unit_price_minor, buyer_user_id, expires_at FROM reservations WHERE source = 'auction' AND source_id = $1`, [auctionId]);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ unit_price_minor: 600_000, buyer_user_id: b.id });
    expect(new Date(res.rows[0].expires_at).getTime() - (endsAt.getTime() + 1_000)).toBe(24 * HOUR);
    expect(row.winner_delivery_quote.state).toBe('Lagos');
    expect(await stock(listing.id)).toMatchObject({ quantity_available: 0, quantity_reserved: 1 });
  });

  it('T06: a finaliser that crashes midway leaves nothing behind and a rerun recovers', async () => {
    const { auctionId, endsAt } = await liveAuction();
    const w = await bidder('W');
    await bid(w, auctionId, 5_000);
    const later = systemCtx(() => new Date(endsAt.getTime() + 5_000));
    finalizeHooks.afterReserve = () => {
      throw new Error('simulated crash');
    };
    await expect(finalizeAuction(later, auctionId)).rejects.toThrow('simulated crash');
    expect((await auctionRow(auctionId)).status).toBe('live');
    expect((await pool.query(`SELECT count(*)::int AS n FROM reservations WHERE source = 'auction' AND source_id = $1`, [auctionId])).rows[0].n).toBe(0);
    // The page tells the truth meanwhile: ended (finalising), no bids accepted.
    const view = await getAuctionView(later, auctionId);
    expect(view.phase).toBe('ended');
    finalizeHooks.afterReserve = undefined;
    expect(await finalizeAuction(later, auctionId)).toBe('winner_allocated');
    expect(await finalizeAuction(later, auctionId)).toBe('already_final');
  });

  it('an auction without bids ends, withdraws the unit, and can be relisted as a new auction', async () => {
    const { auctionId, endsAt, listing, seller } = await liveAuction();
    expect(await finalizeAuction(systemCtx(() => new Date(endsAt.getTime() + 1)), auctionId)).toBe('ended_no_bids');
    expect(await stock(listing.id)).toMatchObject({ quantity_available: 0 });
    expect((await pool.query('SELECT status FROM listings WHERE id = $1', [listing.id])).rows[0].status).toBe('ended');
    const mine = await shopAuctions(seller.ctx);
    expect(mine.items.find((i) => i.id === auctionId)).toMatchObject({ canRelist: true, canCancel: false });
    const re = await relistAuction(seller.ctx, { auctionId, startsAt: 'now', endsAt: new Date(Date.now() + HOUR).toISOString(), openingPrice: '4000', increment: '400' });
    expect(re.auctionId).not.toBe(auctionId);
    expect(await stock(listing.id)).toMatchObject({ quantity_available: 1 });
    expect(await auctionRow(re.auctionId)).toMatchObject({ status: 'live', relisted_from_id: auctionId });
    await expect(relistAuction(seller.ctx, { auctionId, startsAt: 'now', endsAt: new Date(Date.now() + HOUR).toISOString(), openingPrice: '4000', increment: '400' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    // Discovery still shows one card for the listing (latest auction only).
    const live = await listAuctions(systemCtx(), { status: 'live', limit: 48 });
    expect(live.items.filter((i) => i.id === listing.id)).toHaveLength(1);
  });
});

describe('T07 winner misses the payment deadline', () => {
  it('fails unpaid with a strike, then a second chance reserves only after the runner-up accepts', async () => {
    const { auctionId, endsAt, seller, listing } = await liveAuction();
    const winner = await bidder('Winner');
    const runnerUp = await bidder('Runner');
    const third = await bidder('Third');
    await bid(third, auctionId, 5_000);
    await bid(runnerUp, auctionId, 5_500);
    await bid(third, auctionId, 6_000);
    await bid(runnerUp, auctionId, 6_500);
    await bid(winner, auctionId, 7_000);
    await finalizeAuction(systemCtx(() => new Date(endsAt.getTime() + 1)), auctionId);
    const a = await auctionRow(auctionId);
    const strikesBefore = await strikeCount(pool, winner.id);
    // The checkout worker releases the hold only after confirming no payment can still succeed.
    await withTransaction(pool, async (tx) => {
      await releaseReservation(tx, a.reservation_id, { reason: 'hold_expired', status: 'expired' });
      await enqueueReservationReleased(tx, a.reservation_id);
    });
    const payload = { reservationId: a.reservation_id, source: 'auction', sourceId: auctionId, listingId: listing.id };
    await withTransaction(pool, (tx) => onAuctionReservationReleased(tx, payload));
    await withTransaction(pool, (tx) => onAuctionReservationReleased(tx, payload));
    expect(await auctionRow(auctionId)).toMatchObject({ status: 'failed_unpaid' });
    expect(await strikeCount(pool, winner.id)).toBe(strikesBefore + 1);
    expect((await pool.query('SELECT status FROM listings WHERE id = $1', [listing.id])).rows[0].status).toBe('draft');
    // Nobody else has been reserved or charged.
    expect((await pool.query(`SELECT count(*)::int AS n FROM reservations WHERE listing_id = $1 AND status IN ('active','payment_pending')`, [listing.id])).rows[0].n).toBe(0);
    expect(await stock(listing.id)).toMatchObject({ quantity_available: 1, quantity_reserved: 0 });

    await expect(offerSecondChance(runnerUp.ctx, { auctionId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const offer = await offerSecondChance(seller.ctx, { auctionId });
    expect(offer.amountMinor).toBe(650_000);
    await expect(offerSecondChance(seller.ctx, { auctionId })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect((await pool.query(`SELECT count(*)::int AS n FROM reservations WHERE listing_id = $1 AND status = 'active'`, [listing.id])).rows[0].n).toBe(0);
    await expect(acceptSecondChance(third.ctx, { offerId: offer.offerId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const view = await getAuctionView(runnerUp.ctx, auctionId);
    expect(view.viewer.secondChance).toMatchObject({ offerId: offer.offerId, amountMinor: 650_000, status: 'pending' });

    const accepted = await acceptSecondChance(runnerUp.ctx, { offerId: offer.offerId });
    const r = (await pool.query('SELECT source, unit_price_minor, buyer_user_id, status FROM reservations WHERE id = $1', [accepted.reservationId])).rows[0];
    expect(r).toMatchObject({ source: 'second_chance', unit_price_minor: 650_000, buyer_user_id: runnerUp.id, status: 'active' });
    expect(await acceptSecondChance(runnerUp.ctx, { offerId: offer.offerId })).toEqual(accepted);

    // Runner-up pays at the agreed amount; the auction completes.
    const addressId = (await pool.query('SELECT id FROM addresses WHERE user_id = $1', [runnerUp.id])).rows[0].id;
    const ctx = await getCheckoutContext(runnerUp.ctx, { secondChance: offer.offerId });
    expect(ctx.listing.unitPriceMinor).toBe(650_000);
    const started = await startCheckoutForReservation(runnerUp.ctx, { reservationId: accepted.reservationId, addressId, deliveryMethod: 'seller_arranged', idempotencyKey: key() });
    await pay(systemCtx(), started.orderId);
    await withTransaction(pool, (tx) => onAuctionOrderPaid(tx, { orderId: started.orderId }));
    expect(await auctionRow(auctionId)).toMatchObject({ status: 'paid' });
  });

  it('a declined second chance can go to the next bidder; nothing is reserved meanwhile', async () => {
    const { auctionId, endsAt, seller, listing } = await liveAuction();
    const [w, r1, r2] = await Promise.all([bidder('W'), bidder('R1'), bidder('R2')]);
    await bid(r2, auctionId, 5_000);
    await bid(r1, auctionId, 5_500);
    await bid(w, auctionId, 6_000);
    await finalizeAuction(systemCtx(() => new Date(endsAt.getTime() + 1)), auctionId);
    const a = await auctionRow(auctionId);
    await withTransaction(pool, (tx) => releaseReservation(tx, a.reservation_id, { reason: 'hold_expired', status: 'expired' }));
    await withTransaction(pool, (tx) => onAuctionReservationReleased(tx, { reservationId: a.reservation_id, source: 'auction', sourceId: auctionId }));
    const first = await offerSecondChance(seller.ctx, { auctionId });
    await declineSecondChance(r1.ctx, { offerId: first.offerId });
    const second = await offerSecondChance(seller.ctx, { auctionId });
    expect(second.amountMinor).toBe(500_000);
    expect((await pool.query(`SELECT bidder_user_id FROM second_chance_offers WHERE id = $1`, [second.offerId])).rows[0].bidder_user_id).toBe(r2.id);
    expect(await stock(listing.id)).toMatchObject({ quantity_available: 1, quantity_reserved: 0 });
  });
});

describe('auction view', () => {
  it('masks other bidders and shows the viewer’s own state', async () => {
    const { auctionId } = await liveAuction();
    const alice = await bidder('Alice Unique-Name');
    const bob = await bidder('Bob Unique-Name');
    await bid(alice, auctionId, 5_000);
    await bid(bob, auctionId, 5_500);
    const asAlice = await getAuctionView(alice.ctx, auctionId);
    const json = JSON.stringify(asAlice);
    expect(json).not.toContain(bob.id);
    expect(json).not.toContain('Bob Unique-Name');
    expect(json).not.toContain(bob.email);
    expect(asAlice.bids.map((b) => b.bidderLabel)).toEqual(['Bidder 2', 'You']);
    expect(asAlice.viewer).toMatchObject({ isLeader: false, canBid: true, hasBid: true });
    expect(asAlice.minimumNextBidMinor).toBe(600_000);
    expect(asAlice.rules.lines.join(' ')).toContain('final 2 minutes');
    const asBob = await getAuctionView(bob.ctx, auctionId);
    expect(asBob.viewer).toMatchObject({ isLeader: true, canBid: false, cannotBidReason: 'You have the highest bid.' });
    const guest = await getAuctionView(ctxFor({ kind: 'guest' }), auctionId);
    expect(guest.viewer).toMatchObject({ signedIn: false, canBid: false });
    expect(JSON.stringify(guest)).not.toContain(alice.id);
  });
});

describe('auction custody under moderation (doc 06)', () => {
  it('removing a listing stops its live auction first: bidders are told, nothing is charged and nothing gets stuck', async () => {
    const { listing, auctionId } = await liveAuction();
    const b = await bidder('Moderated bidder');
    await bid(b, auctionId, 5_000);
    const reporter = await createUser({ name: 'Reporter' });
    const ts = await createUser({ roles: ['trust_safety'] });
    const { reportId } = await submitReport(reporter.ctx, { kind: 'listing', id: listing.id, reason: 'counterfeit', details: 'Fake logo.' });
    await actOnReport(ts.ctx, { reportId, action: 'remove_listing', reason: 'Counterfeit branding confirmed by photos' });

    const a = await auctionRow(auctionId);
    expect(a.status).toBe('cancelled');
    expect(a.cancelled_reason).toMatch(/^moderation: /);
    expect((await pool.query('SELECT status FROM listings WHERE id = $1', [listing.id])).rows[0].status).toBe('removed');
    expect(await stock(listing.id)).toMatchObject({ quantity_available: 0, quantity_reserved: 0 });
    const note = await pool.query(`SELECT body FROM notifications WHERE user_id = $1 AND kind = 'auction_cancelled'`, [b.id]);
    expect(note.rows[0].body).toContain('never payments');
    // No further bids, and the closing job has nothing left to allocate (no stuck auction).
    await expect(bid(b, auctionId, 6_000)).rejects.toMatchObject({ code: 'EXPIRED' });
    const afterEnd = new Date(Date.now() + 2 * HOUR);
    expect(await finalizeAuction(systemCtx(() => afterEnd), auctionId)).toBe('already_final');
  });

  it('suspending a shop stops its scheduled and live auctions; a paused or suspended shop takes no bids', async () => {
    const shop = await createShop();
    const live = await liveAuction({ shop });
    const b = await bidder('Shop bidder');
    await bid(b, live.auctionId, 5_000);
    const reporter = await createUser({ name: 'Shop reporter' });
    const ts = await createUser({ roles: ['trust_safety'] });
    const { reportId } = await submitReport(reporter.ctx, { kind: 'shop', id: shop.id, reason: 'fraud', details: 'Asked me to pay by transfer.' });
    await actOnReport(ts.ctx, { reportId, action: 'suspend_shop', reason: 'Repeated off-platform payment requests' });
    expect((await auctionRow(live.auctionId)).status).toBe('cancelled');
    expect((await pool.query('SELECT status FROM listings WHERE id = $1', [live.listing.id])).rows[0].status).toBe('draft');
    await expect(bid(b, live.auctionId, 6_000)).rejects.toMatchObject({ code: 'INVALID_STATE' });

    // A paused shop can't leave an auction running, and bids are refused if a shop isn't active.
    const other = await liveAuction();
    await expect(pauseShop(other.seller.ctx, {})).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await pool.query(`UPDATE shops SET status = 'paused' WHERE id = $1`, [other.listing.shop.id]);
    await expect(bid(await bidder('Paused bidder'), other.auctionId, 5_000)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});

