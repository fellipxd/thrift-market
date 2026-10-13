import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { followedShops, setFollow } from '../../src';
import { memoPublic } from '../../src/core/memo';
import { closeTestServices, createUser, guestCtx } from '../support';
import { addPhoto, auctionListing, createShop, ensureDiscoveryReferenceData, listing, setListing } from './helpers';

afterAll(closeTestServices);
beforeAll(ensureDiscoveryReferenceData);

const HOUR = 3_600_000;

describe('shop cards (active count and thumbnails without per-listing auction joins)', () => {
  it('counts buyable pieces and live/scheduled auctions only, and shows the newest photographed pieces first', async () => {
    const shop = await createShop();
    const now = Date.now();
    const older = await listing(shop, 'Older fixed piece', { publishedAt: new Date(now - 3 * HOUR) });
    const newer = await listing(shop, 'Newer fixed piece', { publishedAt: new Date(now - HOUR) });
    const paused = await listing(shop, 'Paused piece', { status: 'paused' });
    const sold = await listing(shop, 'Sold piece', { status: 'sold' });
    const live = await auctionListing(shop, 'Live auction piece', { status: 'live', startsAt: new Date(now - HOUR), endsAt: new Date(now + HOUR), openingMinor: 100_000 });
    await setListing(live.id, { publishedAt: new Date(now - 2 * HOUR) });
    const overdue = await auctionListing(shop, 'Past end, not yet closed', { status: 'live', startsAt: new Date(now - 3 * HOUR), endsAt: new Date(now - 60_000), openingMinor: 100_000 });
    const ended = await auctionListing(shop, 'Ended auction piece', { status: 'ended_no_bids', startsAt: new Date(now - 5 * HOUR), endsAt: new Date(now - 4 * HOUR), openingMinor: 100_000 });
    const keys: Record<string, string> = {};
    for (const l of [older, newer, paused, sold, live, overdue, ended]) keys[l.id] = await addPhoto(l.id, shop.owner.id);

    const fan = await createUser();
    await setFollow(fan.ctx, { shopId: shop.id, follow: true });
    const card = (await followedShops(fan.ctx)).find((s) => s.id === shop.id)!;
    expect(card.activeCount).toBe(3); // two fixed-price pieces + the live auction
    expect(card.thumbnails.map((t) => t.split('/').pop()!.replace('.thumb', ''))).toEqual(
      [newer, live, older].map((l) => keys[l.id]!.split('/').pop()!),
    );
  });
});

describe('short public cache', () => {
  it('shares one computation between concurrent callers, serves it until it expires, then refreshes (bypassed in tests)', async () => {
    const dev = { ...guestCtx(), config: { ...guestCtx().config, env: 'development' as const } };
    let calls = 0;
    const slow = () => new Promise<number>((r) => setTimeout(() => r(++calls), 30));
    const key = `memo-test-${Date.now()}`;
    expect(await Promise.all([memoPublic(dev, key, 200, slow), memoPublic(dev, key, 200, slow), memoPublic(dev, key, 200, slow)])).toEqual([1, 1, 1]);
    expect(await memoPublic(dev, key, 200, slow)).toBe(1);
    await new Promise((r) => setTimeout(r, 250));
    expect(await memoPublic(dev, key, 200, slow)).toBe(2);
    expect(await memoPublic(guestCtx(), key, 200, slow)).toBe(3);
  });
});
