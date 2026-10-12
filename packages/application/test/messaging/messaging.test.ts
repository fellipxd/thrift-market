import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assessMessageSafety,
  blockConversationParty,
  conversationUpdates,
  getConversation,
  inboxUnreadCount,
  linkOrderConversation,
  listConversations,
  markConversationRead,
  sendMessage,
  startConversation,
  startOrderConversation,
  unblockConversationParty,
} from '../../src';
import { withTransaction } from '@thrift/database';
import { closeTestServices, createListing, createShop, createUser, systemCtx, testServices } from '../support';
import { ensureCheckoutReferenceData, key } from '../checkout/helpers';

afterAll(closeTestServices);
beforeAll(ensureCheckoutReferenceData);

async function setup() {
  const listing = await createListing({ saleMode: 'negotiable', minOfferMinor: 600_000 });
  const buyer = await createUser({ name: 'Bola Buyer' });
  const { conversationId } = await startConversation(buyer.ctx, { listingId: listing.id });
  return { listing, buyer, seller: listing.shop.owner, conversationId };
}

describe('conversations', () => {
  it('reuses one conversation per buyer and item, and refuses messaging your own shop', async () => {
    const { listing, buyer, seller, conversationId } = await setup();
    const again = await startConversation(buyer.ctx, { listingId: listing.id });
    expect(again).toEqual({ conversationId, created: false });
    await expect(startConversation(seller.ctx, { listingId: listing.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const unverified = await createUser({ verified: false });
    await expect(startConversation(unverified.ctx, { listingId: listing.id })).rejects.toMatchObject({ code: 'CONTACT_UNVERIFIED' });
    const draft = await createListing({ status: 'draft' });
    await expect(startConversation(buyer.ctx, { listingId: draft.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('T08: only the buyer and members of the shop can read or send', async () => {
    const { buyer, seller, conversationId } = await setup();
    await sendMessage(buyer.ctx, { conversationId, body: 'Hello, is this still available?', clientKey: key() });
    const stranger = await createUser();
    const otherSeller = (await createShop()).owner;
    const staff = await createUser({ roles: ['support'] });
    for (const u of [stranger, otherSeller, staff]) {
      await expect(getConversation(u.ctx, conversationId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(sendMessage(u.ctx, { conversationId, body: 'hi', clientKey: key() })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(conversationUpdates(u.ctx, conversationId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    const otherShopList = await listConversations(otherSeller.ctx, { as: 'seller' });
    expect(otherShopList.items.map((c) => c.id)).not.toContain(conversationId);
    const sellerView = await getConversation(seller.ctx, conversationId);
    expect(sellerView.role).toBe('seller');
    expect(sellerView.messages.at(-1)?.body).toBe('Hello, is this still available?');
    // Buyer contact details never reach the seller.
    expect(JSON.stringify(sellerView)).not.toContain(buyer.email);
  });

  it('sends idempotently on the client key, tracks unread counts and notifies the other side', async () => {
    const { buyer, seller, conversationId } = await setup();
    const k = key();
    const a = await sendMessage(buyer.ctx, { conversationId, body: 'Can you share the waist measurement?', clientKey: k });
    const b = await sendMessage(buyer.ctx, { conversationId, body: 'Can you share the waist measurement?', clientKey: k });
    expect(b.id).toBe(a.id);
    const { pool } = testServices();
    expect((await pool.query('SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1', [conversationId])).rows[0].n).toBe(1);
    const sellerList = await listConversations(seller.ctx, { as: 'seller' });
    const row = sellerList.items.find((c) => c.id === conversationId)!;
    expect(row.unread).toBe(1);
    expect(row.counterpartName).toBe('Bola Buyer');
    expect(await inboxUnreadCount(seller.ctx)).toBeGreaterThanOrEqual(1);
    expect((await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND dedupe_key = $2`, [seller.id, `msg:${a.id}`])).rows[0].n).toBe(1);
    await markConversationRead(seller.ctx, { conversationId });
    expect((await listConversations(seller.ctx, { as: 'seller' })).items.find((c) => c.id === conversationId)!.unread).toBe(0);
    const reply = await sendMessage(seller.ctx, { conversationId, body: 'Waist is 76cm flat.', clientKey: key() });
    expect(reply.senderRole).toBe('seller');
    const buyerList = await listConversations(buyer.ctx, { as: 'buyer' });
    expect(buyerList.items.find((c) => c.id === conversationId)).toMatchObject({ unread: 1, lastMessagePreview: 'Waist is 76cm flat.' });
    // Polling returns only newer messages.
    const updates = await conversationUpdates(buyer.ctx, conversationId, { after: a.id });
    expect(updates.messages.map((m) => m.id)).toEqual([reply.id]);
  });

  it('blocked users cannot message or start conversations until unblocked', async () => {
    const { listing, buyer, seller, conversationId } = await setup();
    await blockConversationParty(seller.ctx, { conversationId });
    await expect(sendMessage(buyer.ctx, { conversationId, body: 'hello?', clientKey: key() })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(sendMessage(seller.ctx, { conversationId, body: 'hello?', clientKey: key() })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const view = await getConversation(seller.ctx, conversationId);
    expect(view.block).toEqual({ blocked: true, byViewer: true });
    expect((await getConversation(buyer.ctx, conversationId)).block).toEqual({ blocked: true, byViewer: false });
    // The buyer can't unblock the seller's block.
    expect(await unblockConversationParty(buyer.ctx, { conversationId })).toEqual({ blocked: true });
    const other = await createListing({ shop: listing.shop });
    await expect(startConversation(buyer.ctx, { listingId: other.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await unblockConversationParty(seller.ctx, { conversationId })).toEqual({ blocked: false });
    await sendMessage(buyer.ctx, { conversationId, body: 'Thanks!', clientKey: key() });
  });

  it('rate limits new conversations for new accounts and rejects cross-conversation duplicate spam', async () => {
    const buyer = await createUser();
    const listings = await Promise.all(Array.from({ length: 7 }, () => createListing()));
    for (const l of listings.slice(0, 3)) await startConversation(buyer.ctx, { listingId: l.id });
    await expect(startConversation(buyer.ctx, { listingId: listings[3]!.id })).rejects.toMatchObject({ code: 'RATE_LIMITED' });

    const spammer = await createUser();
    await testServices().pool.query(`UPDATE users SET created_at = now() - interval '10 days' WHERE id = $1`, [spammer.id]);
    const convs: string[] = [];
    for (const l of listings.slice(0, 6)) convs.push((await startConversation(spammer.ctx, { listingId: l.id })).conversationId);
    const spam = 'Cheap designer bags available, visit my page!!';
    for (const c of convs.slice(0, 5)) await sendMessage(spammer.ctx, { conversationId: c, body: spam, clientKey: key() });
    await expect(sendMessage(spammer.ctx, { conversationId: convs[5]!, body: spam.toUpperCase(), clientKey: key() })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('attaches only the sender’s own ready chat photos and flags off-platform payment talk', async () => {
    const { buyer, seller, conversationId } = await setup();
    const { pool } = testServices();
    const media = await pool.query(
      `INSERT INTO media_assets (owner_user_id, purpose, storage_key, mime_type, bytes, sha256, visibility) VALUES ($1, 'message', $2, 'image/webp', 10, 'x', 'restricted') RETURNING id`,
      [seller.id, `test/${key()}`],
    );
    await expect(sendMessage(buyer.ctx, { conversationId, body: '', mediaId: media.rows[0].id, clientKey: key() })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const photo = await sendMessage(seller.ctx, { conversationId, body: '', mediaId: media.rows[0].id, clientKey: key() });
    expect(photo.kind).toBe('image');
    expect(photo.image?.url).toMatch(/sig=/);
    const risky = await sendMessage(seller.ctx, { conversationId, body: 'Just send money to my Opay account 8031234567 to avoid fees', clientKey: key() });
    expect(risky.safetyFlag).toBe(true);
    expect(assessMessageSafety('Is the colour accurate in the photos?').flagged).toBe(false);
    await expect(sendMessage(buyer.ctx, { conversationId, body: '   ', clientKey: key() })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('links the conversation to a paid order once, and opens order conversations for either party', async () => {
    const { listing, buyer, seller, conversationId } = await setup();
    const { pool } = testServices();
    const order = await pool.query(
      `INSERT INTO orders (buyer_user_id, shop_id, source, items_total_minor, shipping_minor, buyer_fee_minor, total_minor, commission_minor, delivery_method, shipping_address, delivery_terms, policy_versions, status, payment_status, paid_at)
       VALUES ($1, $2, 'checkout', 850000, 0, 0, 850000, 0, 'seller_arranged', '{}', '{}', '{}', 'confirmed', 'paid', now()) RETURNING id, number`,
      [buyer.id, listing.shop.id],
    );
    const orderId = order.rows[0].id as string;
    await pool.query(`INSERT INTO order_items (order_id, listing_id, quantity, unit_price_minor, snapshot) VALUES ($1, $2, 1, 850000, '{}')`, [orderId, listing.id]);
    await withTransaction(pool, (tx) => linkOrderConversation(tx, { orderId }));
    await withTransaction(pool, (tx) => linkOrderConversation(tx, { orderId }));
    const view = await getConversation(buyer.ctx, conversationId);
    expect(view.order?.id).toBe(orderId);
    expect(view.messages.filter((m) => m.kind === 'system' && m.body.includes(order.rows[0].number))).toHaveLength(1);
    expect(await startOrderConversation(seller.ctx, { orderId })).toEqual({ conversationId });
    await expect(startOrderConversation((await createUser()).ctx, { orderId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    void systemCtx;
  });
});
