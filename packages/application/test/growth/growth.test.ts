import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@thrift/database';
import {
  describeUnsubscribe,
  followedDigest,
  getNotificationPreferences,
  listNotifications,
  makeUnsubscribeToken,
  markAllNotificationsRead,
  markNotificationRead,
  notifyUser,
  onAuctionScheduled,
  onBatchDropped,
  setFollow,
  setFollowDrops,
  unsubscribe,
  updateNotificationPreferences,
} from '../../src';
import { closeTestServices, createListing, createShop, createUser, systemCtx, testServices, type TestUser } from '../support';
import { ensureCheckoutReferenceData, key } from '../checkout/helpers';

afterAll(closeTestServices);
beforeAll(ensureCheckoutReferenceData);

const pool = () => testServices().pool;

async function batchFor(shopId: string): Promise<string> {
  return (await pool().query(`INSERT INTO batches (shop_id, name) VALUES ($1, 'Friday drop') RETURNING id`, [shopId])).rows[0].id;
}

async function optIn(u: TestUser, prefs: Record<string, string>): Promise<void> {
  await updateNotificationPreferences(u.ctx, prefs);
}

async function drops(userId: string, batchId: string): Promise<number> {
  return (await pool().query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND dedupe_key = $2`, [userId, `drop:${batchId}`])).rows[0].n;
}

describe('T14 drop notifications', () => {
  it('duplicate drop events notify each opted-in follower once; others get nothing', async () => {
    const shop = await createShop();
    const optedIn = await createUser();
    const notOptedIn = await createUser();
    const mutedShop = await createUser();
    const blocker = await createUser();
    for (const u of [optedIn, notOptedIn, mutedShop, blocker]) await setFollow(u.ctx, { shopId: shop.id, follow: true });
    await optIn(optedIn, { 'pref:new_drops:in_app': 'on' });
    await optIn(mutedShop, { 'pref:new_drops:in_app': 'on' });
    await optIn(blocker, { 'pref:new_drops:in_app': 'on' });
    await setFollowDrops(mutedShop.ctx, { shopId: shop.id, notifyDrops: false });
    await pool().query(`INSERT INTO user_blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2)`, [blocker.id, shop.owner.id]);
    const batchId = await batchFor(shop.id);
    const payload = { batchId, shopId: shop.id, listingCount: 3 };
    await Promise.all([1, 2, 3].map(() => withTransaction(pool(), (tx) => onBatchDropped(systemCtx(), tx, payload))));
    await withTransaction(pool(), (tx) => onBatchDropped(systemCtx(), tx, payload));
    expect(await drops(optedIn.id, batchId)).toBe(1);
    expect(await drops(notOptedIn.id, batchId)).toBe(0);
    expect(await drops(mutedShop.id, batchId)).toBe(0);
    expect(await drops(blocker.id, batchId)).toBe(0);
  });

  it('email opt-in queues one outbound message with a working one-click unsubscribe link', async () => {
    const shop = await createShop();
    const u = await createUser();
    await setFollow(u.ctx, { shopId: shop.id, follow: true });
    await optIn(u, { 'pref:new_drops:email': 'on' });
    const prefs = await getNotificationPreferences(u.ctx);
    const cell = prefs.topics.find((t) => t.topic === 'new_drops')!.cells.find((c) => c.channel === 'email')!;
    expect(cell.on).toBe(true);
    expect(cell.consentedAt).not.toBeNull();
    const batchId = await batchFor(shop.id);
    await withTransaction(pool(), (tx) => onBatchDropped(systemCtx(), tx, { batchId, shopId: shop.id }));
    await withTransaction(pool(), (tx) => onBatchDropped(systemCtx(), tx, { batchId, shopId: shop.id }));
    const out = (await pool().query(`SELECT body FROM outbound_messages WHERE user_id = $1 AND channel = 'email'`, [u.id])).rows;
    expect(out).toHaveLength(1);
    const token = decodeURIComponent(/token=([^\s]+)/.exec(out[0].body)![1]!);
    expect(describeUnsubscribe(systemCtx(), token)).toEqual({ topic: 'new_drops', channel: 'email' });
    await unsubscribe(systemCtx(), token);
    await unsubscribe(systemCtx(), token);
    const after = await getNotificationPreferences(u.ctx);
    expect(after.topics.find((t) => t.topic === 'new_drops')!.cells.find((c) => c.channel === 'email')!.on).toBe(false);
  });

  it('rejects tampered or transactional unsubscribe tokens', async () => {
    const u = await createUser();
    const good = makeUnsubscribeToken(systemCtx(), { userId: u.id, topic: 'promotions', channel: 'email' });
    const [payload, sig] = good.split('.');
    const forgedPayload = Buffer.from(JSON.stringify([u.id, 'digest', 'email'])).toString('base64url');
    await expect(unsubscribe(systemCtx(), `${forgedPayload}.${sig}`)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(unsubscribe(systemCtx(), `${payload}.${sig!.slice(0, -2)}xx`)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const tx = makeUnsubscribeToken(systemCtx(), { userId: u.id, topic: 'transactional', channel: 'email' });
    await expect(unsubscribe(systemCtx(), tx)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(unsubscribe(systemCtx(), good)).resolves.toEqual({ topic: 'promotions', channel: 'email' });
  });

  it('followers hear about scheduled auctions once; daily digest goes only to opted-in users, once a day', async () => {
    const shop = await createShop();
    const f = await createUser();
    await setFollow(f.ctx, { shopId: shop.id, follow: true });
    const listing = await createListing({ shop, saleMode: 'auction' });
    const auction = (await pool().query(
      `INSERT INTO auctions (listing_id, shop_id, status, starts_at, ends_at, original_ends_at, opening_price_minor, increment_minor)
       VALUES ($1, $2, 'scheduled', now() + interval '1 day', now() + interval '2 days', now() + interval '2 days', 500000, 50000) RETURNING id`,
      [listing.id, shop.id],
    )).rows[0].id;
    for (let i = 0; i < 2; i++) await withTransaction(pool(), (tx) => onAuctionScheduled(systemCtx(), tx, { auctionId: auction, shopId: shop.id }));
    expect((await pool().query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND dedupe_key = $2`, [f.id, `auction-scheduled:${auction}`])).rows[0].n).toBe(1);

    const digestUser = await createUser();
    await setFollow(digestUser.ctx, { shopId: shop.id, follow: true });
    await optIn(digestUser, { 'pref:digest:in_app': 'on' });
    await createListing({ shop });
    await followedDigest(systemCtx());
    await followedDigest(systemCtx());
    expect((await pool().query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'followed_digest'`, [digestUser.id])).rows[0].n).toBe(1);
    expect((await pool().query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'followed_digest'`, [f.id])).rows[0].n).toBe(0);
  });
});

describe('notification centre', () => {
  it('lists unread first, marks read only your own, and transactional in-app cannot be turned off', async () => {
    const u = await createUser();
    const other = await createUser();
    for (const k of ['a', 'b', 'c']) {
      await notifyUser(pool(), { userId: u.id, topic: 'transactional', kind: 'test', title: `Notice ${k}`, link: '/orders', dedupeKey: `t:${k}:${key()}` });
    }
    const list = await listNotifications(u.ctx);
    expect(list.unread).toBe(3);
    await expect(markNotificationRead(other.ctx, { notificationId: list.items[0]!.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await markNotificationRead(u.ctx, { notificationId: list.items[0]!.id })).toEqual({ link: '/orders' });
    const after = await listNotifications(u.ctx);
    expect(after.unread).toBe(2);
    expect(after.items.at(-1)?.read).toBe(true);
    await markAllNotificationsRead(u.ctx);
    expect((await listNotifications(u.ctx)).unread).toBe(0);
    // Saving preferences with everything off never disables transactional in-app notices.
    await updateNotificationPreferences(u.ctx, {});
    const prefs = await getNotificationPreferences(u.ctx);
    expect(prefs.topics[0]!.cells[0]).toMatchObject({ topic: 'transactional', channel: 'in_app', on: true, locked: true });
    expect((await notifyUser(pool(), { userId: u.id, topic: 'transactional', kind: 'x', title: 'Still here', dedupeKey: key() })).created).toBe(true);
    expect((await notifyUser(pool(), { userId: u.id, topic: 'messages', kind: 'x', title: 'Muted', dedupeKey: key() })).created).toBe(false);
  });
});
