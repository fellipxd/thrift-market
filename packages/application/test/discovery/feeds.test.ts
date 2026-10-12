import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deliveryOptionsFor, type ShopCoverage } from '@thrift/domain';
import { followedShops, getHomeFeed, nearbyShops, savedItems, searchListings, setFollow, setSaved } from '../../src';
import { closeTestServices, createUser, guestCtx, testServices } from '../support';
import { campaign, createShop, ensureDiscoveryReferenceData, listing, placeId, setCoverage, setListing, setShop } from './helpers';

/** Coordinates and private fields only (a place descriptor named `location` is allowed). */
const COORDS = /"(lat|lng|latitude|longitude|coordinates|min_offer_minor|minOfferMinor|distance_m|distanceMeters|distanceKm|point)"\s*:/;

afterAll(closeTestServices);
beforeAll(ensureDiscoveryReferenceData);

describe('deliverable destination filter matches the domain rules (T11)', () => {
  it('agrees with deliveryOptionsFor across coverage scopes, exclusions, listing narrowing and courier routes', async () => {
    const tag = `dlv${Date.now().toString(36)}`;
    const configs: { cov: Parameters<typeof setCoverage>[1]; listingStates: string[] | null }[] = [
      { cov: { scope: 'local' }, listingStates: null },
      { cov: { scope: 'states', states: ['Ogun'] }, listingStates: null },
      { cov: { scope: 'national', excluded: ['Kano'] }, listingStates: null },
      { cov: { scope: 'national' }, listingStates: ['Oyo'] },
      { cov: { scope: 'national', sellerArranged: false, integrated: true }, listingStates: null }, // needs courier route
      { cov: { scope: 'national', sellerArranged: false, integrated: false, pickup: true }, listingStates: null }, // same city only
    ];
    const destinations = [
      { state: 'Lagos', city: 'Lagos' },
      { state: 'Lagos', city: 'Ikeja' },
      { state: 'Ogun', city: 'Abeokuta' },
      { state: 'Kano', city: 'Kano' },
      { state: 'Oyo', city: 'Ibadan' },
      { state: 'Borno', city: 'Maiduguri' }, // no sandbox courier route
    ];
    const pool = testServices().pool;
    const made: { id: string; cfg: (typeof configs)[number] }[] = [];
    for (const cfg of configs) {
      const shop = await createShop();
      await setShop(shop.id, { state: 'Lagos', city: 'Lagos' });
      await setCoverage(shop.id, cfg.cov);
      const l = await listing(shop, `${tag} piece ${made.length}`, { deliveryStates: cfg.listingStates });
      made.push({ id: l.id, cfg });
    }
    for (const dest of destinations) {
      const res = await searchListings(guestCtx(), { q: tag, deliverTo: dest.state, city: dest.city, limit: 48 });
      const got = new Set(res.items.map((i) => i.id));
      for (const m of made) {
        const c = m.cfg.cov!;
        const coverage: ShopCoverage = {
          scope: c.scope,
          states: c.states ?? [],
          excludedStates: c.excluded ?? [],
          offersPickup: c.pickup ?? false,
          offersSellerArranged: c.sellerArranged ?? true,
          offersIntegrated: c.integrated ?? false,
          sameCityFeeMinor: 1,
          sameStateFeeMinor: 1,
          interstateFeeMinor: 1,
          transitDaysMin: 1,
          transitDaysMax: 2,
        };
        const route = await pool.query(`SELECT 1 FROM courier_routes WHERE provider = 'sandbox_courier' AND origin_state = 'Lagos' AND destination_state = $1 AND active`, [dest.state]);
        const expected =
          deliveryOptionsFor({
            coverage,
            shop: { state: 'Lagos', city: 'Lagos', dispatchDays: 2 },
            destination: dest,
            listingStates: m.cfg.listingStates,
            courierRoute: route.rowCount ? { originState: 'Lagos', destinationState: dest.state, feeMinor: 1, transitDaysMin: 1, transitDaysMax: 2 } : null,
          }).length > 0;
        expect({ dest, cfg: m.cfg, included: got.has(m.id) }).toEqual({ dest, cfg: m.cfg, included: expected });
      }
    }
  });
});

describe('nearby shops (R08)', () => {
  it('orders by distance, honours the radius and filters, and never returns coordinates', async () => {
    const yaba = await createShop();
    await setShop(yaba.id, { lat: 6.5095, lng: 3.3711, state: 'Lagos', city: 'Lagos', area: 'Yaba', verification: 'approved' });
    await listing(yaba, 'Nearby yaba piece');
    const lekki = await createShop();
    await setShop(lekki.id, { lat: 6.4698, lng: 3.5852, state: 'Lagos', city: 'Lagos', area: 'Lekki', verification: 'unverified' });
    await listing(lekki, 'Nearby lekki piece');
    const ibadan = await createShop();
    await setShop(ibadan.id, { lat: 7.3775, lng: 3.947, state: 'Oyo', city: 'Ibadan' });
    await listing(ibadan, 'Nearby ibadan piece');

    const place = await placeId('Yaba', 'area');
    const res = await nearbyShops(guestCtx(), { place, radius: '50' });
    const ids = res.shops.map((s) => s.id);
    expect(ids.indexOf(yaba.id)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(lekki.id)).toBeGreaterThan(ids.indexOf(yaba.id));
    expect(ids).not.toContain(ibadan.id);
    expect(JSON.stringify(res)).not.toMatch(COORDS);
    const yabaRow = res.shops.find((s) => s.id === yaba.id)!;
    expect(JSON.stringify(yabaRow)).toMatch(/km/);

    const verifiedOnly = await nearbyShops(guestCtx(), { place, radius: '50', verified: '1' });
    expect(verifiedOnly.shops.map((s) => s.id)).toContain(yaba.id);
    expect(verifiedOnly.shops.map((s) => s.id)).not.toContain(lekki.id);

    const wide = await nearbyShops(guestCtx(), { place, radius: 'national' });
    expect(wide.shops.map((s) => s.id)).toContain(ibadan.id);
  });

  it('device coordinates are matched to a reference place and not echoed back', async () => {
    const res = await nearbyShops(guestCtx(), { lat: '6.5101', lng: '3.3702', radius: '10' });
    expect(res.location?.label).toBeTruthy();
    expect(JSON.stringify(res)).not.toContain('6.5101');
  });
});

describe('home feed sponsorship', () => {
  it('shows only active, in-window campaigns for available listings, flagged as sponsored', async () => {
    const shop = await createShop();
    // Older than the organic "new drops" window, so it can only appear through its campaign.
    const live = await listing(shop, 'Sponsored live piece', { publishedAt: new Date(Date.now() - 40 * 86_400_000) });
    const expired = await listing(shop, 'Sponsored expired piece');
    const sold = await listing(shop, 'Sponsored sold piece');
    await campaign({ shopId: shop.id, listingId: live.id, placement: 'home_feed' });
    await campaign({ shopId: shop.id, listingId: expired.id, placement: 'home_feed', startsAt: new Date(Date.now() - 3 * 86_400_000), endsAt: new Date(Date.now() - 86_400_000) });
    await campaign({ shopId: shop.id, listingId: sold.id, placement: 'home_feed' });
    await setListing(sold.id, { status: 'sold' });
    // Other test files create home-feed campaigns; only three sponsored slots rotate, so isolate this scenario.
    await testServices().pool.query(
      `UPDATE ad_campaigns SET status = 'ended' WHERE placement = 'home_feed' AND status = 'active' AND listing_id <> ALL($1::uuid[])`,
      [[live.id, expired.id, sold.id]],
    );
    // Push the old sponsored piece out of the 12 newest organic items.
    for (let i = 0; i < 14; i++) await listing(shop, `Fresh organic filler ${i}`);
    const feed = await getHomeFeed(guestCtx(), null);
    const sponsored = feed.newDrops.filter((c) => c.sponsored);
    const ids = sponsored.map((s) => s.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(expired.id);
    expect(ids).not.toContain(sold.id);
    expect(feed.following).toBeNull();
    // Never more than two sponsored cards in a row.
    let run = 0;
    for (const c of feed.newDrops) {
      run = c.sponsored ? run + 1 : 0;
      expect(run).toBeLessThanOrEqual(2);
    }
    expect(JSON.stringify(feed)).not.toMatch(COORDS);
  });
});

describe('saved and followed collections', () => {
  it('return only the caller’s own data and separate unavailable items', async () => {
    const shop = await createShop();
    const a = await listing(shop, 'Saved available piece');
    const b = await listing(shop, 'Saved then sold piece');
    const alice = await createUser();
    const bob = await createUser();
    await setSaved(alice.ctx, { listingId: a.id, saved: true });
    await setSaved(alice.ctx, { listingId: b.id, saved: true });
    await setListing(b.id, { status: 'sold' });
    await setFollow(alice.ctx, { shopId: shop.id, follow: true });
    const mine = await savedItems(alice.ctx, {});
    expect(mine.available.map((i) => i.id)).toContain(a.id);
    expect(mine.unavailable.map((i) => i.id)).toContain(b.id);
    const bobs = await savedItems(bob.ctx, {});
    expect(bobs.available).toHaveLength(0);
    expect((await followedShops(alice.ctx)).map((s) => s.id)).toContain(shop.id);
    expect(await followedShops(bob.ctx)).toHaveLength(0);
    await expect(savedItems(guestCtx(), {})).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('performance sanity', () => {
  it('searches 2,000 listings quickly with indexes', async () => {
    const pool = testServices().pool;
    const shop = await createShop();
    const seed = await listing(shop, 'Perf template piece');
    await pool.query(
      `INSERT INTO listings (shop_id, category_id, schema_version_id, status, sale_mode, title, description, size_system, size_label, condition,
                             flaws_declaration, quantity_mode, price_minor, published_at)
       SELECT shop_id, category_id, schema_version_id, 'active', 'fixed', 'Perf denim jacket ' || g, 'bulk', 'uk', '12', 'good', 'none_known', 'unique',
              100000 + g * 10, now() - (g || ' minutes')::interval
         FROM listings, generate_series(1, 2000) g WHERE id = $1`,
      [seed.id],
    );
    await pool.query(`INSERT INTO inventory_stock (listing_id, quantity_total, quantity_available)
                      SELECT id, 1, 1 FROM listings WHERE title LIKE 'Perf denim jacket %' ON CONFLICT DO NOTHING`);
    await pool.query('ANALYZE listings');
    const started = performance.now();
    const res = await searchListings(guestCtx(), { q: 'denim jacket', sort: 'newest', limit: 24 });
    const res2 = await searchListings(guestCtx(), { sort: 'price_asc', minPrice: '1000', maxPrice: '1200', limit: 24 });
    const ms = performance.now() - started;
    expect(res.items.length).toBe(24);
    expect(res2.items.length).toBe(24);
    expect(ms).toBeLessThan(2000);
  });
});
