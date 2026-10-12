import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { many, one } from '@thrift/database';
import {
  bookPromotion,
  cancelPromotion,
  decideRefund,
  getHomeFeed,
  searchListings,
  maintainPromotions,
  payForPromotion,
  processRefunds,
  recordPromotionClick,
  recordPromotionImpressions,
  registerAllJobs,
  requestPromotionRefund,
  reviewPromotion,
  sellerInsights,
  sellerPromotions,
  staffEndPromotion,
  staffPromotionQueue,
  startCheckout,
  unbalancedLedgerTransactions,
  type PromotionViewer,
} from '../../src';
import { simulateSandboxPayment } from '../../src/payments/webhooks';
import { seedAdPackages } from '../../src/seed/base';
import { closeTestServices, createListing, createShop, createUser, systemCtx, testServices, type TestListing } from '../support';
import { addAddress, ensureCheckoutReferenceData, key, pay } from '../checkout/helpers';

afterAll(closeTestServices);
beforeAll(async () => {
  await ensureCheckoutReferenceData();
  await seedAdPackages(testServices().pool);
  registerAllJobs();
});

const pool = () => testServices().pool;

async function packageId(code: string): Promise<string> {
  return (await one<{ id: string }>(pool(), 'SELECT id FROM ad_packages WHERE code = $1', [code])).id;
}

async function campaign(id: string): Promise<Record<string, any>> {
  return one(pool(), 'SELECT * FROM ad_campaigns WHERE id = $1', [id]);
}

async function latestReference(campaignId: string): Promise<string> {
  return (await one<{ reference: string }>(pool(), 'SELECT reference FROM payment_attempts WHERE ad_campaign_id = $1 ORDER BY created_at DESC LIMIT 1', [campaignId])).reference;
}

async function payPromotion(campaignId: string, outcome: 'succeeded' | 'failed' = 'succeeded'): Promise<string> {
  const reference = await latestReference(campaignId);
  await simulateSandboxPayment(systemCtx(), { reference, outcome }, testServices().sandboxPayments as never);
  return reference;
}

async function bookListing(listing: TestListing, code = 'listing-home-3d') {
  return bookPromotion(listing.shop.owner.ctx, { packageId: await packageId(code), listingId: listing.id });
}

async function liveListingPromotion() {
  const listing = await createListing({ priceMinor: 400_000 });
  const booked = await bookListing(listing);
  await payPromotion(booked.campaignId);
  const ts = await createUser({ roles: ['trust_safety'] });
  await reviewPromotion(ts.ctx, { campaignId: booked.campaignId, decision: 'approve', reason: 'Photos and description are fine.' });
  return { listing, campaignId: booked.campaignId, ts };
}

function viewer(key: string, userId: string | null = null, userAgent = 'Mozilla/5.0 (Linux; Android 14) Chrome/126 Mobile'): PromotionViewer {
  return { viewerKey: key, userId, userAgent, secret: testServices().config.appSecret };
}

async function refundsFor(campaignId: string) {
  return many<{ id: string; reason: string; status: string; amount_minor: string }>(pool(), 'SELECT id, reason, status, amount_minor FROM refunds WHERE ad_campaign_id = $1 ORDER BY created_at', [campaignId]);
}

async function adRevenue(shopId: string): Promise<number> {
  const r = await one<{ s: string }>(pool(), `SELECT coalesce(sum(amount_minor), 0) AS s FROM ledger_entries WHERE account = 'ad_revenue' AND shop_id = $1`, [shopId]);
  return Number(r.s);
}

describe('R22 paid promotion lifecycle', () => {
  it('book → provider-confirmed payment → review → live and labelled sponsored; ads revenue posted to a balanced ledger', async () => {
    const word = `promo${Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('')}`;
    const listing = await createListing({ priceMinor: 400_000, title: `Ankara ${word} dress` });
    const booked = await bookListing(listing, 'listing-search-7d');
    expect(booked.authorizationUrl).toContain('/sandbox/pay/');
    expect((await campaign(booked.campaignId)).status).toBe('awaiting_payment');
    // Nothing shows before payment and approval.
    expect((await searchListings(systemCtx(), { q: word })).sponsored).toEqual([]);

    await payPromotion(booked.campaignId);
    const paid = await campaign(booked.campaignId);
    expect(paid.status).toBe('pending_review');
    expect(paid.paid_at).not.toBeNull();
    expect(await adRevenue(listing.shop.id)).toBe(-300_000);
    expect(await unbalancedLedgerTransactions(pool())).toEqual([]);
    expect((await searchListings(systemCtx(), { q: word })).sponsored).toEqual([]);

    // Sellers can't approve their own promotions; support can't either.
    await expect(reviewPromotion(listing.shop.owner.ctx, { campaignId: booked.campaignId, decision: 'approve', reason: 'Looks good to me.' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(reviewPromotion((await createUser({ roles: ['support'] })).ctx, { campaignId: booked.campaignId, decision: 'approve', reason: 'Looks good to me.' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const ts = await createUser({ roles: ['trust_safety'] });
    expect((await staffPromotionQueue(ts.ctx, 'review')).some((r) => r.id === booked.campaignId)).toBe(true);
    await reviewPromotion(ts.ctx, { campaignId: booked.campaignId, decision: 'approve', reason: 'Photos and description are fine.' });
    const live = await campaign(booked.campaignId);
    expect(live.status).toBe('active');
    expect(new Date(live.ends_at).getTime() - new Date(live.starts_at).getTime()).toBe(7 * 86_400_000);

    const result = await searchListings(systemCtx(), { q: word });
    expect(result.sponsored.map((c) => [c.id, c.sponsored])).toEqual([[listing.id, true]]);
    const n = await one<{ n: number }>(pool(), `SELECT count(*)::int AS n FROM notifications WHERE kind = 'promotion_live' AND user_id = $1`, [listing.shop.owner.id]);
    expect(n.n).toBe(1);
  });

  it('a rejected promotion is refunded in full automatically, with the reason shared', async () => {
    const listing = await createListing();
    const booked = await bookListing(listing);
    await payPromotion(booked.campaignId);
    const ts = await createUser({ roles: ['trust_safety'] });
    await reviewPromotion(ts.ctx, { campaignId: booked.campaignId, decision: 'reject', reason: 'The photos show a different item.' });
    expect((await campaign(booked.campaignId)).status).toBe('rejected');
    const [refund] = await refundsFor(booked.campaignId);
    expect(refund).toMatchObject({ reason: 'promotion_rejected', status: 'approved' });
    await processRefunds(systemCtx(), 100);
    expect((await refundsFor(booked.campaignId))[0]!.status).toBe('succeeded');
    expect(Number((await campaign(booked.campaignId)).refund_minor)).toBe(150_000);
    expect(await adRevenue(listing.shop.id)).toBe(0);
    expect(await unbalancedLedgerTransactions(pool())).toEqual([]);
    const note = await one<{ body: string }>(pool(), `SELECT body FROM notifications WHERE kind = 'promotion_rejected' AND user_id = $1`, [listing.shop.owner.id]);
    expect(note.body).toContain('The photos show a different item.');
  });

  it('eligibility: own, published, in-stock items only; one open booking per item and placement; paused shops can’t book', async () => {
    const listing = await createListing();
    const stranger = await createShop();
    await expect(bookPromotion(stranger.owner.ctx, { packageId: await packageId('listing-home-3d'), listingId: listing.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const sold = await createListing({ shop: listing.shop, status: 'sold' });
    await expect(bookListing(sold)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(bookPromotion(listing.shop.owner.ctx, { packageId: await packageId('shop-nearby-7d'), listingId: listing.id })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await bookListing(listing);
    await expect(bookListing(listing)).rejects.toMatchObject({ code: 'CONFLICT' });
    // A different placement for the same item is a separate slot.
    await bookListing(listing, 'listing-search-7d');
    const paused = await createShop({ status: 'paused' });
    const pausedListing = await createListing({ shop: paused });
    await expect(bookListing(pausedListing)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('seller cancellation: unpaid closes, paid-but-not-live refunds in full, live can’t be cancelled; other shops can’t touch it', async () => {
    const a = await createListing();
    const unpaid = await bookListing(a);
    await expect(cancelPromotion((await createUser()).ctx, { campaignId: unpaid.campaignId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await cancelPromotion(a.shop.owner.ctx, { campaignId: unpaid.campaignId })).toEqual({ status: 'cancelled', refundMinor: 0 });
    expect(await refundsFor(unpaid.campaignId)).toEqual([]);

    const b = await createListing();
    const paid = await bookListing(b);
    await payPromotion(paid.campaignId);
    expect(await cancelPromotion(b.shop.owner.ctx, { campaignId: paid.campaignId })).toEqual({ status: 'cancelled', refundMinor: 150_000 });
    expect((await refundsFor(paid.campaignId))[0]).toMatchObject({ reason: 'promotion_cancelled', status: 'approved' });

    const { listing, campaignId } = await liveListingPromotion();
    await expect(cancelPromotion(listing.shop.owner.ctx, { campaignId })).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('a payment that arrives after the booking lapsed is refunded in full; a second payment is refunded as a duplicate', async () => {
    const listing = await createListing();
    const booked = await bookListing(listing);
    // Abandon at the provider, then let the booking lapse.
    await pool().query(`UPDATE payment_attempts SET status = 'abandoned' WHERE ad_campaign_id = $1`, [booked.campaignId]);
    await pool().query(`UPDATE ad_campaigns SET created_at = now() - interval '2 days' WHERE id = $1`, [booked.campaignId]);
    await maintainPromotions(systemCtx());
    expect((await campaign(booked.campaignId)).status).toBe('cancelled');
    // The shopper had actually paid on the provider page.
    await pool().query(`UPDATE payment_attempts SET status = 'pending' WHERE ad_campaign_id = $1`, [booked.campaignId]);
    await payPromotion(booked.campaignId);
    const late = await refundsFor(booked.campaignId);
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ reason: 'promotion_cancelled', status: 'approved' });

    const other = await createListing();
    const first = await bookListing(other);
    const firstRef = await latestReference(first.campaignId);
    // Seller opens a second attempt before the first resolves, then both succeed.
    await pool().query(`UPDATE payment_attempts SET status = 'failed' WHERE reference = $1`, [firstRef]);
    await payForPromotion(other.shop.owner.ctx, { campaignId: first.campaignId });
    await pool().query(`UPDATE payment_attempts SET status = 'pending' WHERE reference = $1`, [firstRef]);
    await simulateSandboxPayment(systemCtx(), { reference: firstRef, outcome: 'succeeded' }, testServices().sandboxPayments as never);
    await payPromotion(first.campaignId);
    expect((await campaign(first.campaignId)).status).toBe('pending_review');
    expect((await refundsFor(first.campaignId)).map((r) => r.reason)).toEqual(['duplicate_payment']);
    await processRefunds(systemCtx(), 100);
    expect(Number((await campaign(first.campaignId)).refund_minor)).toBe(0);
    expect(await unbalancedLedgerTransactions(pool())).toEqual([]);
  });

  it('T14: a sold item leaves promotion; unused-time refunds are staff requests needing a second approver', async () => {
    const { listing, campaignId, ts } = await liveListingPromotion();
    await pool().query(`UPDATE listings SET status = 'sold' WHERE id = $1`, [listing.id]);
    const feed = await getHomeFeed(systemCtx(), null);
    expect(feed.newDrops.find((c) => c.id === listing.id)).toBeUndefined();
    await maintainPromotions(systemCtx());
    const ended = await campaign(campaignId);
    expect(ended).toMatchObject({ status: 'ended', end_reason: 'listing_unavailable' });
    expect(await refundsFor(campaignId)).toEqual([]);
    const mine = (await sellerPromotions(listing.shop.owner.ctx)).promotions.find((p) => p.id === campaignId)!;
    expect(mine.endedEarly).toBe(true);
    expect(mine.unusedMinor).toBeGreaterThan(140_000);

    const support = await createUser({ roles: ['support'] });
    await expect(requestPromotionRefund(listing.shop.owner.ctx, { campaignId, amount: 1000, note: 'Item sold on day one, refund it.' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(requestPromotionRefund(support.ctx, { campaignId, amount: 2000, note: 'Item sold on day one, refund it.' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const req = await requestPromotionRefund(support.ctx, { campaignId, amount: 1000, note: 'Item sold on day one, refund it.' });
    expect(req.status).toBe('requested');
    await expect(requestPromotionRefund(ts.ctx, { campaignId, amount: 100, note: 'Another request for the same promotion.' })).rejects.toMatchObject({ code: 'CONFLICT' });
    const finance = await createUser({ roles: ['finance'] });
    await decideRefund(finance.ctx, { refundId: req.refundId, decision: 'approve', reason: 'Matches unused time.' });
    await processRefunds(systemCtx(), 100);
    expect(Number((await campaign(campaignId)).refund_minor)).toBe(100_000);
    expect(await unbalancedLedgerTransactions(pool())).toEqual([]);
  });

  it('four-eyes on unused-time refunds: the requester can’t approve their own request', async () => {
    const { campaignId, ts } = await liveListingPromotion();
    await staffEndPromotion(ts.ctx, { campaignId, reason: 'Listing breaks the photo rules.' });
    expect((await campaign(campaignId)).status).toBe('ended');
    const finance = await createUser({ roles: ['finance'] });
    const req = await requestPromotionRefund(finance.ctx, { campaignId, amount: 500, note: 'Stopped by staff early on.' });
    await expect(decideRefund(finance.ctx, { refundId: req.refundId, decision: 'approve', reason: 'Approving my own.' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const admin = await createUser({ roles: ['admin'] });
    await decideRefund(admin.ctx, { refundId: req.refundId, decision: 'reject', reason: 'Policy breach, no refund.' });
    expect((await refundsFor(campaignId))[0]!.status).toBe('rejected');
  });

  it('promotions finish at their scheduled end without counting as early', async () => {
    const { listing, campaignId } = await liveListingPromotion();
    await pool().query(`UPDATE ad_campaigns SET starts_at = now() - interval '4 days', ends_at = now() - interval '1 hour' WHERE id = $1`, [campaignId]);
    await maintainPromotions(systemCtx());
    const c = await campaign(campaignId);
    expect(c).toMatchObject({ status: 'ended', end_reason: 'completed' });
    expect(new Date(c.ended_at).getTime()).toBe(new Date(c.ends_at).getTime());
    const mine = (await sellerPromotions(listing.shop.owner.ctx)).promotions.find((p) => p.id === campaignId)!;
    expect(mine.endedEarly).toBe(false);
  });
});

describe('promotion reporting', () => {
  it('impressions and clicks are deduplicated per shopper per day, exclude bots and the shop’s own team; attribution is informational', async () => {
    const { listing, campaignId } = await liveListingPromotion();
    const placement = 'home_feed' as const;
    await recordPromotionImpressions(pool(), { placement, targetIds: [listing.id], viewer: viewer('a:1.2.3.4:ua') });
    await recordPromotionImpressions(pool(), { placement, targetIds: [listing.id], viewer: viewer('a:1.2.3.4:ua') });
    await recordPromotionImpressions(pool(), { placement, targetIds: [listing.id], viewer: viewer('a:5.6.7.8:ua') });
    await recordPromotionImpressions(pool(), { placement, targetIds: [listing.id], viewer: viewer('a:9.9.9.9:bot', null, 'Googlebot/2.1') });
    await recordPromotionImpressions(pool(), { placement, targetIds: [listing.id], viewer: viewer(`u:${listing.shop.owner.id}`, listing.shop.owner.id) });
    // A different placement doesn't count for this campaign.
    await recordPromotionImpressions(pool(), { placement: 'search_results', targetIds: [listing.id], viewer: viewer('a:7.7.7.7:ua') });

    const buyer = await createUser({ name: 'Clicker' });
    const href = await recordPromotionClick(pool(), { placement, targetId: listing.id, viewer: viewer(`u:${buyer.id}`, buyer.id) });
    expect(href).toBe(`/items/${listing.id}`);
    await recordPromotionClick(pool(), { placement, targetId: listing.id, viewer: viewer(`u:${buyer.id}`, buyer.id) });
    expect(await recordPromotionClick(pool(), { placement, targetId: '00000000-0000-0000-0000-000000000000', viewer: viewer('x') })).toBeNull();

    // The clicker buys the item → one attributed order.
    const addressId = await addAddress(buyer, { state: 'FCT', city: 'Abuja' });
    const started = await startCheckout(buyer.ctx, { listingId: listing.id, addressId, deliveryMethod: 'seller_arranged', idempotencyKey: key() });
    await pay(systemCtx(), started.orderId);

    const report = await sellerPromotions(listing.shop.owner.ctx);
    const row = report.promotions.find((p) => p.id === campaignId)!;
    expect(row).toMatchObject({ impressions: 2, clicks: 1, attributedOrders: 1 });
    expect(row.attributedSalesMinor).toBe(listing.priceMinor);
    expect(report.attributionDays).toBe(7);
    // Other sellers never see this shop's promotions.
    const other = await createShop();
    expect((await sellerPromotions(other.owner.ctx)).promotions.find((p) => p.id === campaignId)).toBeUndefined();
  });

  it('seller insights summarise engagement, sales, offers and stock for the period, per shop only', async () => {
    const shop = await createShop();
    const a = await createListing({ shop, priceMinor: 300_000, title: 'Linen shirt' });
    await createListing({ shop, quantity: 1, status: 'draft' });
    await pool().query(`INSERT INTO listing_daily_stats (listing_id, day, views, saves, messages, offers) VALUES ($1, current_date, 40, 5, 3, 2), ($1, current_date - 3, 10, 1, 0, 0)`, [a.id]);
    const buyer = await createUser();
    const addressId = await addAddress(buyer, { state: 'FCT', city: 'Abuja' });
    const started = await startCheckout(buyer.ctx, { listingId: a.id, addressId, deliveryMethod: 'seller_arranged', idempotencyKey: key() });
    await pay(systemCtx(), started.orderId);

    const ins = await sellerInsights(shop.owner.ctx, 30);
    expect(ins.periodDays).toBe(30);
    expect(ins.engagement).toEqual({ views: 50, saves: 6, messages: 3, offers: 2 });
    expect(ins.sales).toMatchObject({ paidOrders: 1, itemsSold: 1, grossMinor: 300_000, conversionPct: 2 });
    expect(ins.stock.drafts).toBe(1);
    expect(ins.daily).toHaveLength(30);
    expect(ins.topListings[0]).toMatchObject({ id: a.id, views: 50, sold: 1 });
    const week = await sellerInsights(shop.owner.ctx, 7);
    expect(week.daily).toHaveLength(7);

    const other = await createShop();
    const theirs = await sellerInsights(other.owner.ctx, 30);
    expect(theirs.engagement.views).toBe(0);
    expect(theirs.topListings).toEqual([]);
    await expect(sellerInsights((await createUser()).ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
