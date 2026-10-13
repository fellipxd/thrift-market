import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addDisputeEntry,
  archiveAddress,
  bookPromotion,
  cancelOrderBySeller,
  cancelPendingOrder,
  confirmReceipt,
  conversationUpdates,
  getBag,
  getConversation,
  getOrderDetail,
  markConversationRead,
  markDeliveredBySeller,
  markDispatched,
  openDispute,
  orderReviewItems,
  pauseListing,
  removeFromBag,
  removeListing,
  replyToReview,
  respondToDispute,
  retryPayment,
  saveToBag,
  sendMessage,
  startCheckout,
  startConversation,
  submitReview,
  withdrawDispute,
} from '../../src';
import { seedAdPackages } from '../../src/seed/base';
import { addAddress, ensureCheckoutReferenceData, key } from '../checkout/helpers';
import { paidOrder } from '../fulfilment/helpers';
import { closeTestServices, createListing, createShop, createUser, guestCtx, testServices } from '../support';

afterAll(closeTestServices);
beforeAll(async () => {
  await ensureCheckoutReferenceData();
  await seedAdPackages(testServices().pool);
});

/** The wrong party is refused with NOT_FOUND or FORBIDDEN — never a state-specific error that confirms what exists. */
async function denied(label: string, p: Promise<unknown>): Promise<void> {
  const err = await p.then(
    () => null,
    (e: { code?: string }) => e,
  );
  expect(err, `${label} should be refused`).not.toBeNull();
  expect(['NOT_FOUND', 'FORBIDDEN'], `${label} refused with ${err?.code}`).toContain(err?.code);
}

describe('T08: cross-object access between buyers and between sellers', () => {
  it('a second buyer and a second seller cannot read or act on another party’s orders, chats, disputes, reviews, listings or addresses', async () => {
    const pool = testServices().pool;
    // Party A: a shop, a buyer with a reviewed order, a disputed order, a chat, an address and a bag.
    const reviewed = await paidOrder('seller_arranged');
    const shopA = reviewed.listing.shop;
    const sellerA = reviewed.seller;
    const buyerA = reviewed.buyer;
    await markDispatched(sellerA.ctx, { orderId: reviewed.orderId, carrierName: 'Rider' });
    await markDeliveredBySeller(sellerA.ctx, { orderId: reviewed.orderId });
    await confirmReceipt(buyerA.ctx, { orderId: reviewed.orderId });
    const orderItemId = (await pool.query('SELECT id FROM order_items WHERE order_id = $1', [reviewed.orderId])).rows[0].id as string;
    await submitReview(buyerA.ctx, { orderItemId, overall: 5, accuracy: 5, communication: 5, delivery: 5, body: 'Lovely piece.' });
    const reviewId = (await pool.query('SELECT id FROM reviews WHERE order_item_id = $1', [orderItemId])).rows[0].id as string;

    const disputed = await paidOrder('seller_arranged', { listing: await createListing({ shop: shopA }) });
    await markDispatched(sellerA.ctx, { orderId: disputed.orderId, carrierName: 'Rider' });
    await markDeliveredBySeller(sellerA.ctx, { orderId: disputed.orderId });
    await openDispute(disputed.buyer.ctx, { orderId: disputed.orderId, reason: 'undisclosed_defect', description: 'A large stain on the front that was not shown.' });
    const disputeId = (await pool.query('SELECT id FROM disputes WHERE order_id = $1', [disputed.orderId])).rows[0].id as string;

    const chatListing = await createListing({ shop: shopA, saleMode: 'negotiable', minOfferMinor: 500_000 });
    const { conversationId } = await startConversation(buyerA.ctx, { listingId: chatListing.id });
    await sendMessage(buyerA.ctx, { conversationId, body: 'Is this still available?', clientKey: key() });
    const addressA = (await pool.query('SELECT id FROM addresses WHERE user_id = $1 LIMIT 1', [buyerA.id])).rows[0].id as string;
    const bagged = await createListing({ shop: shopA });
    await saveToBag(buyerA.ctx, { listingId: bagged.id });

    // Party B.
    const buyerB = await createUser({ name: 'Other buyer' });
    const addressB = await addAddress(buyerB);
    const shopB = await createShop();
    const sellerB = shopB.owner;

    // Orders: indistinguishable from a missing order.
    const missing = await getOrderDetail(buyerB.ctx, '00000000-0000-4000-8000-000000000000').catch((e) => e);
    const foreign = await getOrderDetail(buyerB.ctx, reviewed.orderId).catch((e) => e);
    expect(foreign.code).toBe('NOT_FOUND');
    expect(foreign.message).toBe(missing.message);
    await denied('seller B reads A’s order', getOrderDetail(sellerB.ctx, reviewed.orderId));
    await denied('buyer B retries A’s payment', retryPayment(buyerB.ctx, { orderId: reviewed.orderId }));
    await denied('buyer B cancels A’s order', cancelPendingOrder(buyerB.ctx, { orderId: reviewed.orderId }));
    await denied('buyer B confirms A’s delivery', confirmReceipt(buyerB.ctx, { orderId: disputed.orderId }));
    await denied('seller B dispatches A’s order', markDispatched(sellerB.ctx, { orderId: disputed.orderId, carrierName: 'Rider' }));
    await denied('seller B marks A’s order delivered', markDeliveredBySeller(sellerB.ctx, { orderId: disputed.orderId }));
    await denied('seller B cancels A’s order', cancelOrderBySeller(sellerB.ctx, { orderId: disputed.orderId, reason: 'Not mine to cancel at all', restock: true }));
    await denied('buyer A (a buyer) acts as A’s seller', markDispatched(buyerA.ctx, { orderId: disputed.orderId, carrierName: 'Rider' }));

    // Disputes.
    await denied('buyer B opens a dispute on A’s order', openDispute(buyerB.ctx, { orderId: reviewed.orderId, reason: 'undisclosed_defect', description: 'Trying to dispute an order that is not mine.' }));
    await denied('buyer B withdraws A’s dispute', withdrawDispute(buyerB.ctx, { disputeId }));
    await denied('seller B answers A’s dispute', respondToDispute(sellerB.ctx, { disputeId, response: 'reject', message: 'This order is not from my shop at all.' }));
    await denied('buyer B adds to A’s dispute', addDisputeEntry(buyerB.ctx, { disputeId, body: 'Adding notes to a stranger’s case.' }));

    // Reviews.
    // The order page's review panel shows nothing to anyone but the buyer (same as for an order that doesn't exist).
    expect(await orderReviewItems(buyerB.ctx, reviewed.orderId)).toEqual([]);
    await denied('buyer B reviews A’s purchase', submitReview(buyerB.ctx, { orderItemId, overall: 1, accuracy: 1, communication: 1, delivery: 1, body: 'Fake review.' }));
    await denied('seller B replies to A’s review', replyToReview(sellerB.ctx, { reviewId, reply: 'Replying for another shop.' }));

    // Conversations.
    await denied('buyer B reads A’s chat', getConversation(buyerB.ctx, conversationId));
    await denied('seller B reads A’s chat', getConversation(sellerB.ctx, conversationId));
    await denied('buyer B posts in A’s chat', sendMessage(buyerB.ctx, { conversationId, body: 'Hello from outside.', clientKey: key() }));
    await denied('buyer B marks A’s chat read', markConversationRead(buyerB.ctx, { conversationId }));
    // Live updates (the polling endpoint behind the chat page) follow the same participant rule.
    await denied('buyer B polls A’s chat', conversationUpdates(buyerB.ctx, conversationId));
    await denied('seller B polls A’s chat', conversationUpdates(sellerB.ctx, conversationId));
    const signedOut = await conversationUpdates(guestCtx(), conversationId).catch((e: { code?: string }) => e);
    expect(['UNAUTHENTICATED', 'NOT_FOUND']).toContain((signedOut as { code?: string }).code);

    // Listings and promotions.
    await denied('seller B pauses A’s listing', pauseListing(sellerB.ctx, { listingId: chatListing.id }));
    await denied('seller B removes A’s listing', removeListing(sellerB.ctx, { listingId: chatListing.id, reason: 'Removing someone else’s listing' }));
    const pkg = (await pool.query(`SELECT id FROM ad_packages WHERE active AND target_kind = 'listing' LIMIT 1`)).rows[0].id as string;
    await denied('seller B promotes A’s listing', bookPromotion(sellerB.ctx, { packageId: pkg, listingId: chatListing.id }));

    // Addresses and bag: B can't use A's address, and nothing B does touches A's bag or address book.
    await denied('buyer B checks out to A’s address', startCheckout(buyerB.ctx, { listingId: bagged.id, addressId: addressA, deliveryMethod: 'seller_arranged', idempotencyKey: key() }));
    await archiveAddress(buyerB.ctx, { addressId: addressA }).catch(() => undefined);
    expect((await pool.query('SELECT archived_at FROM addresses WHERE id = $1', [addressA])).rows[0].archived_at).toBeNull();
    await removeFromBag(buyerB.ctx, { listingId: bagged.id });
    expect((await getBag(buyerA.ctx)).count).toBe(1);
    expect((await getBag(buyerB.ctx)).count).toBe(0);
    expect(addressB).toBeTruthy();
  });
});
