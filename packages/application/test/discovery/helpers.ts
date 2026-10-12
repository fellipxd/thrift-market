import { randomUUID } from 'node:crypto';
import { one } from '@thrift/database';
import { seedCourierRoutes, seedPlaces } from '../../src/seed/base';
import { createListing, createShop, testServices, uniq, type TestListing, type TestShop } from '../support';

/** Reference data discovery needs in the test database (idempotent). */
export async function ensureDiscoveryReferenceData(): Promise<void> {
  const pool = testServices().pool;
  await seedPlaces(pool);
  await seedCourierRoutes(pool);
}

export async function placeId(name: string, kind: 'city' | 'area' | 'state' = 'city'): Promise<string> {
  const r = await one<{ id: string }>(testServices().pool, `SELECT id FROM places WHERE name = $1 AND kind = $2 LIMIT 1`, [name, kind]);
  return r.id;
}

export async function setShop(
  shopId: string,
  fields: Partial<{
    lat: number;
    lng: number;
    noLocation: boolean;
    city: string;
    state: string;
    area: string | null;
    status: string;
    verification: string;
    tier: string;
    reviewCount: number;
    rating: number | null;
  }>,
): Promise<void> {
  const pool = testServices().pool;
  if (fields.noLocation) await pool.query(`UPDATE shops SET location = NULL WHERE id = $1`, [shopId]);
  if (fields.lat !== undefined && fields.lng !== undefined) {
    await pool.query(`UPDATE shops SET location = ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography WHERE id = $1`, [shopId, fields.lng, fields.lat]);
  }
  const sets: string[] = [];
  const values: unknown[] = [shopId];
  const add = (col: string, v: unknown) => {
    values.push(v);
    sets.push(`${col} = $${values.length}`);
  };
  if (fields.city !== undefined) add('city', fields.city);
  if (fields.state !== undefined) add('state', fields.state);
  if (fields.area !== undefined) add('area', fields.area);
  if (fields.status !== undefined) add('status', fields.status);
  if (fields.verification !== undefined) add('verification_status', fields.verification);
  if (fields.tier !== undefined) add('reputation_tier', fields.tier);
  if (fields.reviewCount !== undefined) add('review_count', fields.reviewCount);
  if (fields.rating !== undefined) add('rating_avg', fields.rating);
  if (sets.length) await pool.query(`UPDATE shops SET ${sets.join(', ')} WHERE id = $1`, values);
}

export interface CoverageConfig {
  scope: 'local' | 'states' | 'national';
  states?: string[];
  excluded?: string[];
  pickup?: boolean;
  sellerArranged?: boolean;
  integrated?: boolean;
}

export async function setCoverage(shopId: string, c: CoverageConfig | null): Promise<void> {
  const pool = testServices().pool;
  await pool.query(`DELETE FROM delivery_coverage WHERE shop_id = $1`, [shopId]);
  if (!c) return;
  await pool.query(
    `INSERT INTO delivery_coverage (shop_id, scope, states, excluded_states, offers_pickup, offers_seller_arranged, offers_integrated)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [shopId, c.scope, c.states ?? [], c.excluded ?? [], c.pickup ?? false, c.sellerArranged ?? true, c.integrated ?? false],
  );
}

export async function setListing(
  listingId: string,
  fields: Partial<{
    title: string;
    description: string;
    brand: string | null;
    sizeLabel: string | null;
    condition: string;
    priceMinor: number | null;
    categoryId: string;
    status: string;
    deliveryStates: string[] | null;
    publishedAt: Date | null;
    saleMode: string;
  }>,
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [listingId];
  const add = (col: string, v: unknown) => {
    values.push(v);
    sets.push(`${col} = $${values.length}`);
  };
  if (fields.title !== undefined) add('title', fields.title);
  if (fields.description !== undefined) add('description', fields.description);
  if (fields.brand !== undefined) add('brand', fields.brand);
  if (fields.sizeLabel !== undefined) add('size_label', fields.sizeLabel);
  if (fields.condition !== undefined) add('condition', fields.condition);
  if (fields.priceMinor !== undefined) add('price_minor', fields.priceMinor);
  if (fields.categoryId !== undefined) add('category_id', fields.categoryId);
  if (fields.status !== undefined) add('status', fields.status);
  if (fields.deliveryStates !== undefined) add('delivery_states', fields.deliveryStates);
  if (fields.publishedAt !== undefined) add('published_at', fields.publishedAt);
  if (fields.saleMode !== undefined) add('sale_mode', fields.saleMode);
  if (sets.length) await testServices().pool.query(`UPDATE listings SET ${sets.join(', ')} WHERE id = $1`, values);
}

/** A listing with a given title in a shop, optionally tweaked. */
export async function listing(shop: TestShop, title: string, fields: Parameters<typeof setListing>[1] & { quantity?: number; minOfferMinor?: number } = {}): Promise<TestListing> {
  const { quantity, minOfferMinor, ...rest } = fields;
  const l = await createListing({
    shop,
    title,
    quantity,
    minOfferMinor: minOfferMinor ?? null,
    priceMinor: fields.priceMinor ?? undefined,
    saleMode: fields.saleMode === 'negotiable' ? 'negotiable' : undefined,
  });
  await setListing(l.id, rest);
  return l;
}

/** Auction listing (sale_mode auction, no fixed price) with an auction row. */
export async function auctionListing(
  shop: TestShop,
  title: string,
  a: { status: string; startsAt: Date; endsAt: Date; openingMinor: number; currentBidMinor?: number | null },
): Promise<TestListing & { auctionId: string }> {
  const l = await createListing({ shop, title, saleMode: 'auction' });
  const r = await one<{ id: string }>(
    testServices().pool,
    `INSERT INTO auctions (listing_id, shop_id, status, starts_at, ends_at, original_ends_at, opening_price_minor, increment_minor, current_bid_minor, bid_count)
     VALUES ($1, $2, $3, $4, $5, $5, $6, 50000, $7, $8) RETURNING id`,
    [l.id, shop.id, a.status, a.startsAt, a.endsAt, a.openingMinor, a.currentBidMinor ?? null, a.currentBidMinor ? 1 : 0],
  );
  return { ...l, auctionId: r.id };
}

/** Parent + child category with unique slugs. */
export async function categoryTree(): Promise<{ parentSlug: string; parentId: string; childSlug: string; childId: string }> {
  const pool = testServices().pool;
  const u = uniq().toLowerCase();
  const parent = await one<{ id: string }>(pool, `INSERT INTO categories (slug, name, kind) VALUES ($1, 'Test parent', 'clothes') RETURNING id`, [`tp-${u}`]);
  const child = await one<{ id: string }>(pool, `INSERT INTO categories (slug, name, kind, parent_id) VALUES ($1, 'Test child', 'clothes', $2) RETURNING id`, [
    `tc-${u}`,
    parent.id,
  ]);
  return { parentSlug: `tp-${u}`, parentId: parent.id, childSlug: `tc-${u}`, childId: child.id };
}

export async function addPhoto(listingId: string, ownerUserId: string): Promise<string> {
  const pool = testServices().pool;
  const id = randomUUID();
  const key = `listing/test/${id}.webp`;
  await pool.query(
    `INSERT INTO media_assets (id, owner_user_id, purpose, storage_key, mime_type, bytes, sha256) VALUES ($1, $2, 'listing', $3, 'image/webp', 100, 'x')`,
    [id, ownerUserId, key],
  );
  await pool.query(`INSERT INTO listing_media (listing_id, media_id, position, role) VALUES ($1, $2, 0, 'front')`, [listingId, id]);
  return key;
}

async function ensurePackage(placement: string, target: 'listing' | 'shop'): Promise<string> {
  const pool = testServices().pool;
  const code = `test-${target}-${placement}`;
  const r = await one<{ id: string }>(
    pool,
    `INSERT INTO ad_packages (code, name, target_kind, placement, duration_days, price_minor) VALUES ($1, $1, $2, $3, 7, 100000)
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [code, target, placement],
  );
  return r.id;
}

export async function campaign(args: {
  shopId: string;
  listingId?: string | null;
  placement: 'home_feed' | 'search_results' | 'nearby';
  status?: string;
  startsAt?: Date | null;
  endsAt?: Date | null;
}): Promise<string> {
  const target = args.listingId ? 'listing' : 'shop';
  const pkg = await ensurePackage(args.placement, target);
  const now = Date.now();
  const r = await one<{ id: string }>(
    testServices().pool,
    `INSERT INTO ad_campaigns (shop_id, package_id, target_kind, listing_id, placement, status, price_minor, starts_at, ends_at)
     VALUES ($1, $2, $3, $4, $5, $6, 100000, $7, $8) RETURNING id`,
    [
      args.shopId,
      pkg,
      target,
      args.listingId ?? null,
      args.placement,
      args.status ?? 'active',
      args.startsAt === undefined ? new Date(now - 3_600_000) : args.startsAt,
      args.endsAt === undefined ? new Date(now + 86_400_000) : args.endsAt,
    ],
  );
  return r.id;
}

export { createShop, createListing };

/** Keys that must never appear in discovery responses. */
export const FORBIDDEN_KEYS = /"(lat|lng|latitude|longitude|location|coordinates|min_offer_minor|minOfferMinor|distance_m|distanceMeters|distanceKm|point)"\s*:/;
