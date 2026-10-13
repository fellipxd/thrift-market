import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isDomainError } from '@thrift/domain';
import { searchListings, type SearchResult } from '../../src/discovery';
import { editDistance } from '../../src/discovery/spelling';
import { closeTestServices, guestCtx, testServices, uniq, type TestShop } from '../support';
import {
  auctionListing,
  categoryTree,
  createListing,
  createShop,
  ensureDiscoveryReferenceData,
  FORBIDDEN_KEYS,
  listing,
  placeId,
  setListing,
  setShop,
} from './helpers';

const HOUR = 3_600_000;
const ids = (r: SearchResult) => r.items.map((i) => i.id);

async function expectValidation(p: Promise<unknown>, field?: string): Promise<void> {
  try {
    await p;
  } catch (err) {
    expect(isDomainError(err)).toBe(true);
    expect((err as { code: string }).code).toBe('VALIDATION_FAILED');
    if (field) expect(((err as { details?: { fieldErrors?: Record<string, string> } }).details?.fieldErrors ?? {})[field]).toBeTruthy();
    return;
  }
  throw new Error('expected VALIDATION_FAILED');
}

beforeAll(async () => {
  await ensureDiscoveryReferenceData();
});

afterAll(closeTestServices);

describe('text search', () => {
  let shop: TestShop;
  beforeAll(async () => {
    shop = await createShop();
  });

  it('ranks title matches above description matches and tolerates typos', async () => {
    const titleHit = await listing(shop, 'Relaxed linen shirt', { description: 'Breathable and loose.' });
    const descHit = await listing(shop, 'Cotton camp collar top', { description: 'Feels like linen but it is cotton.' });
    const unrelated = await listing(shop, 'Leather ankle boots', { description: 'Block heel.' });
    const ctx = guestCtx();

    const r = await searchListings(ctx, { q: 'linen', shop: shop.slug });
    expect(r.sort).toBe('relevance');
    expect(ids(r)).toContain(titleHit.id);
    expect(ids(r)).toContain(descHit.id);
    expect(ids(r)).not.toContain(unrelated.id);
    expect(ids(r).indexOf(titleHit.id)).toBeLessThan(ids(r).indexOf(descHit.id));

    const typo = await searchListings(ctx, { q: 'linnen', shop: shop.slug });
    expect(ids(typo)).toContain(titleHit.id);
    expect(ids(typo)).not.toContain(unrelated.id);

    const prefix = await searchListings(ctx, { q: 'leath', shop: shop.slug });
    expect(ids(prefix)).toContain(unrelated.id);

    const brand = await listing(shop, 'Tailored blazer', { brand: 'Zenobia' });
    const byBrand = await searchListings(ctx, { q: 'zenobia', shop: shop.slug });
    expect(ids(byBrand)).toEqual([brand.id]);
  });

  it('corrects misspelled words against the catalogue only when exact matches run short, across pages', async () => {
    const own = await createShop();
    const kaftans: string[] = [];
    for (let i = 0; i < 3; i++) kaftans.push((await listing(own, `Embroidered qwkaftan ${i}`)).id);
    const ctx = guestCtx();

    // Transposed letters: trigram similarity misses this, the catalogue-vocabulary correction does not.
    const first = await searchListings(ctx, { q: 'qwkaftna', shop: own.slug, limit: 2 });
    expect(first.correctedQuery).toBe('qwkaftan');
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = await searchListings(ctx, { q: 'qwkaftna', shop: own.slug, limit: 2, cursor: first.nextCursor! });
    expect([...ids(first), ...ids(second)].sort()).toEqual([...kaftans].sort());

    // Enough exact matches: no correction, and exact-mode cursors keep working.
    const exact = await searchListings(ctx, { q: 'qwkaftan', shop: own.slug, limit: 2 });
    expect(exact.correctedQuery).toBeNull();
    const exactNext = await searchListings(ctx, { q: 'qwkaftan', shop: own.slug, limit: 2, cursor: exact.nextCursor! });
    expect([...ids(exact), ...ids(exactNext)].sort()).toEqual([...kaftans].sort());

    // Nothing close enough: no correction is claimed.
    const none = await searchListings(ctx, { q: 'zzqxvb', shop: own.slug });
    expect(none.items).toEqual([]);
    expect(none.correctedQuery).toBeNull();
  });

  it('measures edit distance with transpositions and an early cut-off', () => {
    expect(editDistance('shrit', 'shirt')).toBe(1);
    expect(editDistance('linnen', 'linen')).toBe(1);
    expect(editDistance('trousres', 'trousers')).toBe(1);
    expect(editDistance('boot', 'boot')).toBe(0);
    expect(editDistance('abc', 'xyzabc', 2)).toBe(3);
    expect(editDistance('blazer', 'sandal', 1)).toBe(2);
  });

  it('treats punctuation-only and hostile queries as plain text', async () => {
    const ctx = guestCtx();
    const r = await searchListings(ctx, { q: `'); DROP TABLE listings; --`, shop: shop.slug });
    expect(Array.isArray(r.items)).toBe(true);
    const pct = await searchListings(ctx, { q: '%_%', shop: shop.slug });
    expect(Array.isArray(pct.items)).toBe(true);
    await expectValidation(searchListings(ctx, { q: 'x'.repeat(101) }), 'q');
  });
});

describe('visibility', () => {
  it('never shows drafts, paused, removed, sold, ended listings or listings of paused/suspended shops; reserved is flagged', async () => {
    const shop = await createShop();
    const token = `vis${uniq()}`;
    const active = await listing(shop, `Active ${token}`);
    const reserved = await listing(shop, `Reserved ${token}`, { status: 'reserved' });
    const hidden = await Promise.all(
      ['draft', 'paused', 'removed', 'sold', 'ended', 'scheduled'].map((status) => listing(shop, `Hidden ${status} ${token}`, { status })),
    );
    const pausedShop = await createShop();
    const suspendedShop = await createShop();
    const inPaused = await listing(pausedShop, `Paused shop ${token}`);
    const inSuspended = await listing(suspendedShop, `Suspended shop ${token}`);
    await setShop(pausedShop.id, { status: 'paused' });
    await setShop(suspendedShop.id, { status: 'suspended' });

    const r = await searchListings(guestCtx(), { q: token, limit: 48 });
    expect(new Set(ids(r))).toEqual(new Set([active.id, reserved.id]));
    expect(r.items.find((i) => i.id === reserved.id)?.status).toBe('reserved');
    for (const h of [...hidden, inPaused, inSuspended]) expect(ids(r)).not.toContain(h.id);
  });

  it('includes scheduled and live auctions with prices and end times, never ended ones', async () => {
    const shop = await createShop();
    const now = new Date();
    const token = `auc${uniq()}`;
    const live = await auctionListing(shop, `Live ${token}`, {
      status: 'live',
      startsAt: new Date(now.getTime() - HOUR),
      endsAt: new Date(now.getTime() + 2 * HOUR),
      openingMinor: 1_000_000,
      currentBidMinor: 1_250_000,
    });
    const scheduled = await auctionListing(shop, `Scheduled ${token}`, {
      status: 'scheduled',
      startsAt: new Date(now.getTime() + HOUR),
      endsAt: new Date(now.getTime() + 5 * HOUR),
      openingMinor: 900_000,
    });
    const overdue = await auctionListing(shop, `Overdue ${token}`, {
      status: 'live',
      startsAt: new Date(now.getTime() - 5 * HOUR),
      endsAt: new Date(now.getTime() - 60_000),
      openingMinor: 900_000,
    });
    const ended = await Promise.all(
      ['ended_no_bids', 'awaiting_payment', 'paid', 'failed_unpaid', 'cancelled', 'draft'].map((status) =>
        auctionListing(shop, `Ended ${status} ${token}`, {
          status,
          startsAt: new Date(now.getTime() - 5 * HOUR),
          endsAt: new Date(now.getTime() + HOUR),
          openingMinor: 900_000,
        }),
      ),
    );
    const noAuctionRow = await createListing({ shop, saleMode: 'auction', title: `No auction ${token}` });

    const r = await searchListings(guestCtx(), { q: token, limit: 48 });
    expect(new Set(ids(r))).toEqual(new Set([live.id, scheduled.id]));
    const liveCard = r.items.find((i) => i.id === live.id)!;
    expect(liveCard.auctionCurrentMinor).toBe(1_250_000);
    expect(liveCard.priceMinor).toBe(1_000_000);
    expect(liveCard.auctionEndsAt).toBeTruthy();
    const schedCard = r.items.find((i) => i.id === scheduled.id)!;
    expect(schedCard.auctionStatus).toBe('scheduled');
    expect(schedCard.auctionStartsAt).toBeTruthy();
    for (const h of [overdue, ...ended, noAuctionRow]) expect(ids(r)).not.toContain(h.id);

    const ending = await searchListings(guestCtx(), { q: token, sort: 'ending_soon' });
    expect(ending.sort).toBe('ending_soon');
    expect(ids(ending)).toEqual([live.id, scheduled.id]);
  });
});

describe('filters', () => {
  let shop: TestShop;
  let token: string;
  beforeAll(async () => {
    shop = await createShop();
    token = `flt${uniq()}`;
  });

  it('filters by category including descendants', async () => {
    const tree = await categoryTree();
    const inParent = await listing(shop, `Parent cat ${token}`, { categoryId: tree.parentId });
    const inChild = await listing(shop, `Child cat ${token}`, { categoryId: tree.childId });
    const elsewhere = await listing(shop, `Other cat ${token}`);
    const parent = await searchListings(guestCtx(), { q: token, category: tree.parentSlug });
    expect(new Set(ids(parent))).toEqual(new Set([inParent.id, inChild.id]));
    expect(parent.filters.category).toEqual({ slug: tree.parentSlug, name: 'Test parent' });
    const child = await searchListings(guestCtx(), { q: token, category: tree.childSlug });
    expect(ids(child)).toEqual([inChild.id]);
    expect(ids(parent)).not.toContain(elsewhere.id);
    await expectValidation(searchListings(guestCtx(), { category: 'no-such-category' }), 'category');
  });

  it('filters by size (multi, case-insensitive), condition, sale mode and price', async () => {
    const s = await createShop();
    const a = await listing(s, `Size M good ${token}`, { sizeLabel: 'M', condition: 'good', priceMinor: 500_000 });
    const b = await listing(s, `Size L unworn ${token}`, { sizeLabel: 'L', condition: 'unworn', priceMinor: 1_500_000, saleMode: 'negotiable' });
    const c = await listing(s, `Size 42 worn ${token}`, { sizeLabel: '42', condition: 'worn', priceMinor: 2_500_000 });
    const auc = await auctionListing(s, `Auction size ${token}`, {
      status: 'live',
      startsAt: new Date(Date.now() - HOUR),
      endsAt: new Date(Date.now() + HOUR),
      openingMinor: 1_000_000,
      currentBidMinor: 3_000_000,
    });
    const ctx = guestCtx();
    expect(new Set(ids(await searchListings(ctx, { shop: s.slug, size: ['m', 'L'] })))).toEqual(new Set([a.id, b.id]));
    expect(new Set(ids(await searchListings(ctx, { shop: s.slug, size: 'M,42' })))).toEqual(new Set([a.id, c.id]));
    expect(new Set(ids(await searchListings(ctx, { shop: s.slug, condition: ['unworn', 'worn'] })))).toEqual(new Set([b.id, c.id]));
    expect(ids(await searchListings(ctx, { shop: s.slug, saleMode: 'negotiable' }))).toEqual([b.id]);
    expect(ids(await searchListings(ctx, { shop: s.slug, saleMode: ['auction'] }))).toEqual([auc.id]);
    // Naira inputs become kobo; auctions filter on the current bid.
    expect(new Set(ids(await searchListings(ctx, { shop: s.slug, minPrice: '10,000', maxPrice: '25000' })))).toEqual(new Set([b.id, c.id]));
    expect(ids(await searchListings(ctx, { shop: s.slug, minPrice: '29000' }))).toEqual([auc.id]);
    const asc = await searchListings(ctx, { shop: s.slug, sort: 'price_asc' });
    expect(ids(asc)).toEqual([a.id, b.id, c.id, auc.id]);
    const desc = await searchListings(ctx, { shop: s.slug, sort: 'price_desc' });
    expect(ids(desc)).toEqual([auc.id, c.id, b.id, a.id]);
    await expectValidation(searchListings(ctx, { minPrice: '9000', maxPrice: '5000' }), 'maxPrice');
    await expectValidation(searchListings(ctx, { minPrice: 'cheap' }), 'minPrice');
    await expectValidation(searchListings(ctx, { condition: 'mint' }), 'condition');
    await expectValidation(searchListings(ctx, { sort: 'random' }), 'sort');
    await expectValidation(searchListings(ctx, { limit: 500 }), 'limit');
  });

  it('filters by shop and verified sellers, and rejects unavailable shops', async () => {
    const verified = await createShop();
    const unverified = await createShop();
    await setShop(verified.id, { verification: 'approved' });
    const v = await listing(verified, `Verified ${token}`);
    const u = await listing(unverified, `Unverified ${token}`);
    const both = await searchListings(guestCtx(), { q: token, verified: '1' });
    expect(ids(both)).toContain(v.id);
    expect(ids(both)).not.toContain(u.id);
    const byShop = await searchListings(guestCtx(), { shop: unverified.slug });
    expect(ids(byShop)).toEqual([u.id]);
    expect(byShop.filters.shop?.slug).toBe(unverified.slug);
    await setShop(unverified.id, { status: 'paused' });
    await expectValidation(searchListings(guestCtx(), { shop: unverified.slug }), 'shop');
  });

  it('filters by distance around a place and sorts nearest first', async () => {
    const ibadan = await placeId('Ibadan');
    const near = await createShop();
    const mid = await createShop();
    const far = await createShop();
    const unknown = await createShop();
    await setShop(near.id, { lat: 7.39, lng: 3.95, city: 'Ibadan', state: 'Oyo' });
    await setShop(mid.id, { lat: 7.52, lng: 3.95, city: 'Ibadan', state: 'Oyo' });
    await setShop(far.id, { lat: 8.13, lng: 4.24, city: 'Ogbomoso', state: 'Oyo' });
    await setShop(unknown.id, { noLocation: true });
    const tk = `geo${uniq()}`;
    const ln = await listing(near, `Near ${tk}`);
    const lm = await listing(mid, `Mid ${tk}`);
    const lf = await listing(far, `Far ${tk}`);
    const lu = await listing(unknown, `Unknown ${tk}`);
    const within = await searchListings(guestCtx(), { q: tk, near: ibadan, radius: '25' });
    expect(new Set(ids(within))).toEqual(new Set([ln.id, lm.id]));
    const nearest = await searchListings(guestCtx(), { q: tk, near: ibadan, sort: 'nearest' });
    expect(nearest.sort).toBe('nearest');
    expect(ids(nearest)).toEqual([ln.id, lm.id, lf.id, lu.id]);
    // nearest without a location falls back to newest
    const fallback = await searchListings(guestCtx(), { q: tk, sort: 'nearest' });
    expect(fallback.sort).toBe('newest');
    await expectValidation(searchListings(guestCtx(), { near: '00000000-0000-4000-8000-000000000000' }), 'near');
  });
});

describe('pagination', () => {
  it('is stable with ties: no duplicates or gaps, even when listings are inserted between pages', async () => {
    const shop = await createShop();
    const tied = new Date(Date.now() - 10 * HOUR);
    const original: string[] = [];
    for (let i = 0; i < 23; i++) {
      const l = await listing(shop, `Tie item ${i}`, { publishedAt: tied, priceMinor: 700_000 });
      original.push(l.id);
    }
    for (const sort of ['newest', 'price_asc', 'price_desc'] as const) {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const r = await searchListings(guestCtx(), { shop: shop.slug, sort, limit: 5, cursor });
        seen.push(...ids(r));
        cursor = r.nextCursor ?? undefined;
        if (pages === 1) {
          // Concurrent inserts between page requests: one newer, one with the exact same sort keys.
          await listing(shop, `Inserted newer ${sort}`, { priceMinor: 700_000 });
          await listing(shop, `Inserted tie ${sort}`, { publishedAt: tied, priceMinor: 700_000 });
        }
        pages++;
        expect(pages).toBeLessThan(20);
      } while (cursor);
      expect(new Set(seen).size).toBe(seen.length);
      for (const id of original) expect(seen).toContain(id);
    }
  });

  it('orders by what a buyer pays now (listed price or current bid) across fixed-price and auction pieces, page by page', async () => {
    const shop = await createShop();
    const now = Date.now();
    const a = await listing(shop, 'Price order A', { priceMinor: 500_000 });
    const c = await listing(shop, 'Price order C', { priceMinor: 1_500_000 });
    const e = await listing(shop, 'Price order E', { priceMinor: 2_500_000 });
    const b = await auctionListing(shop, 'Price order B', { status: 'live', startsAt: new Date(now - HOUR), endsAt: new Date(now + HOUR), openingMinor: 1_000_000 });
    const d = await auctionListing(shop, 'Price order D', { status: 'live', startsAt: new Date(now - HOUR), endsAt: new Date(now + HOUR), openingMinor: 600_000, currentBidMinor: 2_000_000 });
    const expected = [a.id, b.id, c.id, d.id, e.id];
    for (const sort of ['price_asc', 'price_desc'] as const) {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const r = await searchListings(guestCtx(), { shop: shop.slug, sort, limit: 2, cursor });
        seen.push(...ids(r));
        cursor = r.nextCursor ?? undefined;
      } while (cursor);
      expect(seen).toEqual(sort === 'price_asc' ? expected : [...expected].reverse());
    }
  });

  it('rejects tampered cursors and cursors reused with different filters', async () => {
    const shop = await createShop();
    for (let i = 0; i < 3; i++) await listing(shop, `Cursor item ${i}`);
    const first = await searchListings(guestCtx(), { shop: shop.slug, limit: 1 });
    expect(first.total).toEqual({ count: 3, capped: false });
    expect(first.nextCursor).toBeTruthy();
    const second = await searchListings(guestCtx(), { shop: shop.slug, limit: 1, cursor: first.nextCursor! });
    expect(second.total).toBeNull();
    expect(ids(second)).not.toEqual(ids(first));
    await expectValidation(searchListings(guestCtx(), { shop: shop.slug, cursor: 'not-a-real-cursor' }), 'cursor');
    await expectValidation(searchListings(guestCtx(), { shop: shop.slug, sort: 'price_asc', cursor: first.nextCursor! }), 'cursor');
    await expectValidation(searchListings(guestCtx(), { shop: shop.slug, verified: '1', cursor: first.nextCursor! }), 'cursor');
    const forged = Buffer.from(JSON.stringify({ v: 1, s: 'newest', f: 'x', k: ["2020-01-01'; DROP"], i: 'abc' })).toString('base64url');
    await expectValidation(searchListings(guestCtx(), { shop: shop.slug, cursor: forged }), 'cursor');
  });

  it('caps the page size', async () => {
    const r = await searchListings(guestCtx(), {});
    expect(r.items.length).toBeLessThanOrEqual(24);
  });
});

describe('privacy', () => {
  it('never returns min_offer_minor or precise locations', async () => {
    const shop = await createShop();
    await setShop(shop.id, { lat: 9.0712345, lng: 7.4012345 });
    const tk = `prv${uniq()}`;
    await listing(shop, `Private floor ${tk}`, { priceMinor: 990_000, saleMode: 'negotiable', minOfferMinor: 712_345 });
    const abuja = await placeId('Abuja');
    for (const q of [{ q: tk }, { q: tk, near: abuja, sort: 'nearest' }, { q: tk, deliverTo: 'Lagos', city: 'Lagos' }]) {
      const r = await searchListings(guestCtx(), q);
      const json = JSON.stringify(r);
      expect(json).not.toMatch(FORBIDDEN_KEYS);
      expect(json).not.toContain('712345');
      expect(json).not.toContain('9.0712');
      expect(json).not.toContain('7.4012');
      if (r.nextCursor) expect(Buffer.from(r.nextCursor, 'base64url').toString()).not.toContain('9.07');
    }
    // a search for the stored location fields yields nothing special
    const pool = testServices().pool;
    const row = await pool.query(`SELECT min_offer_minor FROM listings WHERE title = $1`, [`Private floor ${tk}`]);
    expect(row.rows[0]?.min_offer_minor).toBe(712_345);
  });
});
