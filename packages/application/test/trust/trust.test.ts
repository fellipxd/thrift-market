import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@thrift/database';
import { computeReputation } from '@thrift/domain';
import {
  actOnReport,
  confirmReceipt,
  markDeliveredBySeller,
  markDispatched,
  moderateReview,
  orderReviewItems,
  replyToReview,
  reputationInputs,
  refreshShopReputation,
  reverseModerationAction,
  sendMessage,
  shopReviews,
  startCheckout,
  startConversation,
  submitReport,
  submitReview,
} from '../../src';
import { closeTestServices, createListing, createShop, createUser, ctxFor, testServices, type TestUser } from '../support';
import { addAddress, ensureCheckoutReferenceData, key } from '../checkout/helpers';
import { paidOrder, row, type PaidOrder } from '../fulfilment/helpers';

afterAll(closeTestServices);
beforeAll(ensureCheckoutReferenceData);

const pool = () => testServices().pool;

async function deliveredAndConfirmed(opts: { shop?: Awaited<ReturnType<typeof createShop>> } = {}): Promise<PaidOrder & { orderItemId: string }> {
  const listing = opts.shop ? await createListing({ shop: opts.shop }) : undefined;
  const o = await paidOrder('seller_arranged', { listing });
  await markDispatched(o.seller.ctx, { orderId: o.orderId, carrierName: 'Rider' });
  await markDeliveredBySeller(o.seller.ctx, { orderId: o.orderId });
  await confirmReceipt(o.buyer.ctx, { orderId: o.orderId });
  const orderItemId = (await pool().query('SELECT id FROM order_items WHERE order_id = $1', [o.orderId])).rows[0].id;
  return { ...o, orderItemId };
}

const review = (u: TestUser, orderItemId: string, overall = 5, body = 'Exactly as described, quick delivery.') =>
  submitReview(u.ctx, { orderItemId, overall, accuracy: overall, communication: 5, delivery: 4, body });

describe('T13 verified-purchase reviews', () => {
  it('only the buyer of a delivered item can review it, once, within the window', async () => {
    const undelivered = await paidOrder('seller_arranged');
    const undeliveredItem = (await pool().query('SELECT id FROM order_items WHERE order_id = $1', [undelivered.orderId])).rows[0].id;
    await expect(review(undelivered.buyer, undeliveredItem)).rejects.toMatchObject({ code: 'INVALID_STATE' });

    const o = await deliveredAndConfirmed();
    const stranger = await createUser();
    await expect(review(stranger, o.orderItemId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(review(o.seller, o.orderItemId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const late = ctxFor(o.buyer.actor, () => new Date(Date.now() + 40 * 86_400_000));
    await expect(submitReview(late, { orderItemId: o.orderItemId, overall: 5, accuracy: 5, communication: 5, delivery: 5, body: '' })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const items = await orderReviewItems(o.buyer.ctx, o.orderId);
    expect(items[0]).toMatchObject({ canReview: true });
    await review(o.buyer, o.orderItemId, 4);
    await expect(review(o.buyer, o.orderItemId)).rejects.toMatchObject({ code: expect.stringMatching(/CONFLICT|INVALID_STATE/) });
    expect((await orderReviewItems(o.buyer.ctx, o.orderId))[0]).toMatchObject({ canReview: false, review: { overall: 4 } });
    // Unpaid checkout orders have nothing to review either.
    const l = await createListing();
    const b = await createUser();
    const s = await startCheckout(b.ctx, { listingId: l.id, addressId: await addAddress(b), deliveryMethod: 'seller_arranged', idempotencyKey: key() });
    const unpaidItem = (await pool().query('SELECT id FROM order_items WHERE order_id = $1', [s.orderId])).rows[0].id;
    await expect(review(b, unpaidItem)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('shows sample size, keeps few-order shops “New seller”, and lets the seller reply once (editable briefly)', async () => {
    const shop = await createShop();
    const o = await deliveredAndConfirmed({ shop });
    const { reviewId } = await review(o.buyer, o.orderItemId, 5);
    const page = await shopReviews(ctxFor({ kind: 'guest' }), shop.slug);
    expect(page.summary).toMatchObject({ count: 1, completedOrders: 1, isNew: true, tierLabel: 'New seller' });
    expect(page.summary.sampleText).toBe('1 review from 1 completed order');
    await expect(replyToReview(o.buyer.ctx, { reviewId, reply: 'Hello' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await replyToReview(shop.owner.ctx, { reviewId, reply: 'Thank you for buying!' });
    await replyToReview(shop.owner.ctx, { reviewId, reply: 'Thank you for buying — enjoy it!' });
    await pool().query(`UPDATE reviews SET seller_replied_at = now() - interval '3 days' WHERE id = $1`, [reviewId]);
    await expect(replyToReview(shop.owner.ctx, { reviewId, reply: 'Editing much later' })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect((await shopReviews(ctxFor({ kind: 'guest' }), shop.slug)).reviews[0]?.sellerReply).toBe('Thank you for buying — enjoy it!');
  });

  it('moderation needs the trust & safety role and a reason; sellers cannot hide reviews', async () => {
    const o = await deliveredAndConfirmed();
    const { reviewId } = await review(o.buyer, o.orderItemId, 1, 'Terrible, the item was ruined.');
    await expect(moderateReview(o.seller.ctx, { reviewId, action: 'hide', reason: 'I do not like this review at all' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const support = await createUser({ roles: ['support'] });
    await expect(moderateReview(support.ctx, { reviewId, action: 'hide', reason: 'Contains personal phone number' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const ts = await createUser({ roles: ['trust_safety'] });
    await expect(moderateReview(ts.ctx, { reviewId, action: 'hide', reason: 'short' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await moderateReview(ts.ctx, { reviewId, action: 'hide', reason: 'Contains the seller’s personal phone number' });
    expect((await pool().query('SELECT status FROM reviews WHERE id = $1', [reviewId])).rows[0].status).toBe('hidden');
    expect((await pool().query(`SELECT count(*)::int AS n FROM moderation_actions WHERE target_id = $1`, [reviewId])).rows[0].n).toBe(1);
  });
});

describe('reputation', () => {
  it('inputs come from service only: cancellations, upheld disputes and on-time dispatch — not ads or verification', async () => {
    const shop = await createShop();
    await deliveredAndConfirmed({ shop });
    const before = await reputationInputs(pool(), shop.id);
    expect(before).toMatchObject({ completedOrders: 1, onTimeDispatches: 1, dispatchesMeasured: 1, sellerCancellations: 0, upheldDisputes: 0 });
    // Paid promotion and verification don't change anything.
    await pool().query(`UPDATE shops SET verification_status = 'approved' WHERE id = $1`, [shop.id]);
    const pkg = await pool().query(`INSERT INTO ad_packages (code, name, target_kind, placement, duration_days, price_minor) VALUES ($1, 'Test', 'shop', 'home_feed', 7, 100000) RETURNING id`, [key()]);
    await pool().query(`INSERT INTO ad_campaigns (shop_id, package_id, target_kind, placement, status, price_minor) VALUES ($1, $2, 'shop', 'home_feed', 'active', 100000)`, [shop.id, pkg.rows[0].id]);
    expect(await reputationInputs(pool(), shop.id)).toEqual(before);
    const r1 = await withTransaction(pool(), (tx) => refreshShopReputation(tx, shop.id));
    expect(r1.tier).toBe('new');
    expect(computeReputation({ ...before, completedOrders: 10, sellerCancellations: 4 }).tier).toBe('under_review');
    expect((await row('orders', (await pool().query('SELECT id FROM orders WHERE shop_id = $1 LIMIT 1', [shop.id])).rows[0].id)).status).toBeTruthy();
    expect((await pool().query('SELECT completed_orders, reputation_tier FROM shops WHERE id = $1', [shop.id])).rows[0]).toMatchObject({ completed_orders: 1, reputation_tier: 'new' });
  });
});

describe('reports and moderation', () => {
  it('validates targets, dedupes open reports, and acting needs a role, a fitting action and a reason', async () => {
    const listing = await createListing();
    const reporter = await createUser();
    await expect(submitReport(reporter.ctx, { kind: 'listing', id: '00000000-0000-0000-0000-000000000000', reason: 'counterfeit', details: '' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(submitReport(listing.shop.owner.ctx, { kind: 'listing', id: listing.id, reason: 'counterfeit', details: '' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const { reportId } = await submitReport(reporter.ctx, { kind: 'listing', id: listing.id, reason: 'counterfeit', details: 'Logo is clearly fake.' });
    await expect(submitReport(reporter.ctx, { kind: 'listing', id: listing.id, reason: 'counterfeit', details: '' })).rejects.toMatchObject({ code: 'CONFLICT' });
    const ts = await createUser({ roles: ['trust_safety'] });
    await expect(actOnReport(reporter.ctx, { reportId, action: 'remove_listing', reason: 'Counterfeit branding confirmed' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(actOnReport(ts.ctx, { reportId, action: 'hide_message', reason: 'Counterfeit branding confirmed' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const res = await actOnReport(ts.ctx, { reportId, action: 'remove_listing', reason: 'Counterfeit branding confirmed by photos' });
    expect((await pool().query('SELECT status FROM listings WHERE id = $1', [listing.id])).rows[0].status).toBe('removed');
    expect((await pool().query('SELECT quantity_available FROM inventory_stock WHERE listing_id = $1', [listing.id])).rows[0].quantity_available).toBe(0);
    expect((await pool().query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'moderation_notice'`, [listing.shop.owner.id])).rows[0].n).toBe(1);
    await expect(actOnReport(ts.ctx, { reportId, action: 'dismiss', reason: 'Second action on same report' })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await reverseModerationAction(ts.ctx, { actionId: res.moderationActionId!, reason: 'Seller proved authenticity with receipt' });
    expect((await pool().query('SELECT status FROM listings WHERE id = $1', [listing.id])).rows[0].status).toBe('draft');
  });

  it('suspending a shop stops new sales; suspending a user revokes their sessions; messages can be hidden', async () => {
    const listing = await createListing();
    const buyer = await createUser();
    const ts = await createUser({ roles: ['trust_safety'] });
    const r1 = await submitReport(buyer.ctx, { kind: 'shop', id: listing.shop.id, reason: 'fraud', details: 'Asked me to pay by transfer.' });
    await actOnReport(ts.ctx, { reportId: r1.reportId, action: 'suspend_shop', reason: 'Repeated off-platform payment requests' });
    const addressId = await addAddress(buyer);
    await expect(startCheckout(buyer.ctx, { listingId: listing.id, addressId, deliveryMethod: 'seller_arranged', idempotencyKey: key() })).rejects.toMatchObject({
      code: expect.stringMatching(/INVALID_STATE|STOCK_CONFLICT|FORBIDDEN|NOT_FOUND/),
    });

    const other = await createListing();
    const spammer = await createUser();
    const { conversationId } = await startConversation(spammer.ctx, { listingId: other.id });
    const msg = await sendMessage(spammer.ctx, { conversationId, body: 'Pay me directly on WhatsApp, cheaper', clientKey: key() });
    await pool().query(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [spammer.id, `h_${key()}`]);
    const r2 = await submitReport(other.shop.owner.ctx, { kind: 'message', id: msg.id, reason: 'spam', details: '' });
    await actOnReport(ts.ctx, { reportId: r2.reportId, action: 'hide_message', reason: 'Off-platform payment solicitation' });
    expect((await pool().query('SELECT hidden_at FROM messages WHERE id = $1', [msg.id])).rows[0].hidden_at).not.toBeNull();
    const r3 = await submitReport(other.shop.owner.ctx, { kind: 'user', id: spammer.id, reason: 'spam', details: 'Same message to many sellers' });
    await actOnReport(ts.ctx, { reportId: r3.reportId, action: 'suspend_user', reason: 'Spam campaign across many sellers' });
    expect((await pool().query('SELECT status FROM users WHERE id = $1', [spammer.id])).rows[0].status).toBe('suspended');
    expect((await pool().query('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL', [spammer.id])).rows[0].n).toBe(0);
    // A stranger can't report a message from a conversation they can't see.
    await expect(submitReport((await createUser()).ctx, { kind: 'message', id: msg.id, reason: 'spam', details: '' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
