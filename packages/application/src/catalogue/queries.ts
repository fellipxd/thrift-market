import { createHash } from 'node:crypto';
import {
  CONDITION_INFO,
  DomainError,
  editRestriction,
  SALE_MODE_LABEL,
  SIZE_SYSTEM_LABEL,
  stateLabel,
  validateForPublish,
  type AttributeSchema,
  type ConditionGrade,
  type MediaRole,
  type PublishIssue,
  type ReputationTier,
  type SaleMode,
  type SizeSystem,
} from '@thrift/domain';
import { many, maybeOne, one, type Queryable } from '@thrift/database';
import { requireOwnShop, requireUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { mediaPath } from '../media/media';
import { describeCoverage, LISTING_STATUS_LABEL, toCoverage, toReputation, toVerificationView, type ReputationView, type VerificationView } from '../shops/queries';
import { isUuid, loadOwnListing, loadSchemaFor, publishCandidate } from './internal';
import { attributeLabel, measurementLabel } from './schema';

// ---------------------------------------------------------------------------
// Public item page
// ---------------------------------------------------------------------------

export type ItemAvailability = 'available' | 'reserved' | 'sold' | 'scheduled' | 'ended' | 'paused' | 'draft' | 'removed';

export interface ListingPhoto {
  mediaId: string;
  url: string;
  thumbUrl: string;
  role: MediaRole;
  caption: string | null;
  alt: string;
}

export interface ListingDetail {
  id: string;
  title: string;
  description: string;
  categoryName: string;
  categorySlug: string;
  brand: string | null;
  colour: string | null;
  material: string | null;
  saleMode: SaleMode;
  saleModeLabel: string;
  priceMinor: number | null;
  condition: ConditionGrade | null;
  conditionLabel: string | null;
  conditionSummary: string | null;
  flawsDeclaration: 'none_known' | 'described' | null;
  flaws: { id: string; description: string; location: string | null; severity: 'minor' | 'moderate' | 'major'; photoIndex: number | null; photoUrl: string | null }[];
  size: { system: SizeSystem | null; systemLabel: string | null; label: string | null };
  measurements: { key: string; label: string; valueCm: number }[];
  attributes: { key: string; label: string; value: string }[];
  photos: ListingPhoto[];
  availability: ItemAvailability;
  quantityMode: 'unique' | 'equivalent';
  /** Only for identical-unit listings; never implies more than recorded stock. */
  quantityAvailable: number | null;
  dropAt: string | null;
  publishedAt: string | null;
  version: number;
  auction: { id: string; status: string; currentBidMinor: number | null; openingPriceMinor: number; endsAt: string; startsAt: string } | null;
  shop: {
    id: string;
    slug: string;
    name: string;
    city: string;
    state: string;
    stateLabel: string;
    area: string | null;
    dispatchDays: number;
    paused: boolean;
    verification: VerificationView;
    reputation: ReputationView;
    coverageSummary: string;
  };
  isOwner: boolean;
  saved: boolean;
  saveCount: number;
}

interface DetailRow {
  id: string;
  shop_id: string;
  schema_version_id: string;
  batch_id: string | null;
  status: ListingDetail['availability'] | 'active';
  sale_mode: SaleMode;
  title: string;
  description: string;
  brand: string | null;
  colour: string | null;
  material: string | null;
  size_system: SizeSystem | null;
  size_label: string | null;
  measurements: Record<string, number>;
  attributes: Record<string, string>;
  condition: ConditionGrade | null;
  flaws_declaration: 'none_known' | 'described' | null;
  quantity_mode: 'unique' | 'equivalent';
  price_minor: number | null;
  version: number;
  published_at: Date | null;
  category_name: string;
  category_slug: string;
  shop_slug: string;
  shop_name: string;
  shop_status: 'draft' | 'active' | 'paused' | 'suspended';
  shop_city: string;
  shop_state: string;
  shop_area: string | null;
  dispatch_days: number;
  verification_status: string;
  verification_label: string | null;
  verified_at: Date | null;
  reputation_tier: ReputationTier;
  completed_orders: number;
  review_count: number;
  rating_avg: number | null;
  quantity_available: number | null;
  drop_at: Date | null;
  drop_announced_at: Date | null;
  [k: string]: unknown;
}

/** Statuses only the owning shop may see. */
const OWNER_ONLY_STATUSES = new Set(['draft', 'paused', 'removed']);

async function viewerIsMember(db: Queryable, ctx: AppContext, shopId: string): Promise<boolean> {
  if (ctx.actor.kind !== 'user') return false;
  return (await maybeOne(db, 'SELECT 1 AS ok FROM shop_members WHERE shop_id = $1 AND user_id = $2', [shopId, ctx.actor.userId])) !== null;
}

/**
 * Everything the item page needs. Never includes the private negotiation minimum. Drafts, paused and removed
 * listings, and listings of draft/suspended shops, are visible only to the owning shop (others get NOT_FOUND).
 */
export async function getListingDetail(ctx: AppContext, listingId: string): Promise<ListingDetail> {
  if (!isUuid(listingId)) throw new DomainError('NOT_FOUND', 'This item could not be found.');
  const r = await maybeOne<DetailRow>(
    ctx.pool,
    `SELECT l.id, l.shop_id, l.schema_version_id, l.batch_id, l.status, l.sale_mode, l.title, l.description, l.brand, l.colour, l.material,
            l.size_system, l.size_label, l.measurements, l.attributes, l.condition, l.flaws_declaration, l.quantity_mode, l.price_minor,
            l.version, l.published_at,
            c.name AS category_name, c.slug AS category_slug,
            s.slug AS shop_slug, s.name AS shop_name, s.status AS shop_status, s.city AS shop_city, s.state AS shop_state, s.area AS shop_area,
            s.dispatch_days, s.verification_status, s.verification_label, s.verified_at, s.reputation_tier, s.completed_orders,
            s.review_count, s.rating_avg,
            st.quantity_available, b.drop_at, b.drop_announced_at
       FROM listings l
       JOIN shops s ON s.id = l.shop_id
       JOIN categories c ON c.id = l.category_id
       LEFT JOIN inventory_stock st ON st.listing_id = l.id
       LEFT JOIN batches b ON b.id = l.batch_id
      WHERE l.id = $1`,
    [listingId],
  );
  if (!r) throw new DomainError('NOT_FOUND', 'This item could not be found.');
  const isOwner = await viewerIsMember(ctx.pool, ctx, r.shop_id);
  if (!isOwner && (OWNER_ONLY_STATUSES.has(r.status) || r.shop_status === 'draft' || r.shop_status === 'suspended')) {
    throw new DomainError('NOT_FOUND', 'This item could not be found.');
  }
  const { schema } = await loadSchemaFor(ctx.pool, r.schema_version_id);
  const photos = await many<{ media_id: string; storage_key: string; role: MediaRole; caption: string | null; alt_text: string | null }>(
    ctx.pool,
    `SELECT lm.media_id, m.storage_key, lm.role, lm.caption, m.alt_text
       FROM listing_media lm JOIN media_assets m ON m.id = lm.media_id
      WHERE lm.listing_id = $1 AND m.status = 'ready' ORDER BY lm.position`,
    [r.id],
  );
  const flaws = await many<{ id: string; description: string; location: string | null; severity: 'minor' | 'moderate' | 'major'; media_id: string | null; storage_key: string | null }>(
    ctx.pool,
    `SELECT f.id, f.description, f.location, f.severity, f.media_id, m.storage_key
       FROM listing_flaws f LEFT JOIN media_assets m ON m.id = f.media_id
      WHERE f.listing_id = $1 ORDER BY f.created_at, f.id`,
    [r.id],
  );
  const coverageRow = await maybeOne<Record<string, unknown>>(ctx.pool, 'SELECT * FROM delivery_coverage WHERE shop_id = $1', [r.shop_id]);
  const coverage = toCoverage((coverageRow ?? {}) as Parameters<typeof toCoverage>[0]);
  const auction = await maybeOne<{ id: string; status: string; current_bid_minor: number | null; opening_price_minor: number; ends_at: Date; starts_at: Date }>(
    ctx.pool,
    `SELECT id, status, current_bid_minor, opening_price_minor, ends_at, starts_at FROM auctions WHERE listing_id = $1
      ORDER BY created_at DESC LIMIT 1`,
    [r.id],
  );
  const saves = await one<{ n: number; mine: boolean }>(
    ctx.pool,
    `SELECT count(*)::int AS n, coalesce(bool_or(user_id = $2), false) AS mine FROM saved_items WHERE listing_id = $1`,
    [r.id, ctx.actor.kind === 'user' ? ctx.actor.userId : null],
  );

  let availability: ItemAvailability;
  switch (r.status) {
    case 'active':
      availability = (r.quantity_available ?? 0) > 0 ? 'available' : 'reserved';
      break;
    default:
      availability = r.status as ItemAvailability;
  }
  if (r.shop_status === 'paused' && (availability === 'available' || availability === 'reserved')) availability = 'paused';

  const photoList: ListingPhoto[] = photos.map((p, i) => ({
    mediaId: p.media_id,
    url: mediaPath(p.storage_key),
    thumbUrl: mediaPath(p.storage_key, 'thumb'),
    role: p.role,
    caption: p.caption,
    alt: p.alt_text ?? `${r.title} — photo ${i + 1}${p.role !== 'general' ? ` (${p.role})` : ''}`,
  }));
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    categoryName: r.category_name,
    categorySlug: r.category_slug,
    brand: r.brand,
    colour: r.colour,
    material: r.material,
    saleMode: r.sale_mode,
    saleModeLabel: SALE_MODE_LABEL[r.sale_mode],
    priceMinor: r.sale_mode === 'auction' ? null : r.price_minor,
    condition: r.condition,
    conditionLabel: r.condition ? CONDITION_INFO[r.condition].label : null,
    conditionSummary: r.condition ? CONDITION_INFO[r.condition].summary : null,
    flawsDeclaration: r.flaws_declaration,
    flaws: flaws.map((f) => {
      const idx = f.media_id ? photos.findIndex((p) => p.media_id === f.media_id) : -1;
      return {
        id: f.id,
        description: f.description,
        location: f.location,
        severity: f.severity,
        photoIndex: idx >= 0 ? idx : null,
        photoUrl: f.storage_key ? mediaPath(f.storage_key) : null,
      };
    }),
    size: { system: r.size_system, systemLabel: r.size_system ? SIZE_SYSTEM_LABEL[r.size_system] : null, label: r.size_label },
    measurements: Object.entries(r.measurements ?? {}).map(([key, valueCm]) => ({ key, label: measurementLabel(schema, key), valueCm })),
    attributes: Object.entries(r.attributes ?? {}).map(([key, value]) => ({ key, label: attributeLabel(schema, key), value })),
    photos: photoList,
    availability,
    quantityMode: r.quantity_mode,
    quantityAvailable: r.quantity_mode === 'equivalent' ? (r.quantity_available ?? 0) : null,
    dropAt: r.status === 'scheduled' && r.drop_at ? new Date(r.drop_at).toISOString() : null,
    publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
    version: r.version,
    auction: auction
      ? {
          id: auction.id,
          status: auction.status,
          currentBidMinor: auction.current_bid_minor,
          openingPriceMinor: auction.opening_price_minor,
          endsAt: new Date(auction.ends_at).toISOString(),
          startsAt: new Date(auction.starts_at).toISOString(),
        }
      : null,
    shop: {
      id: r.shop_id,
      slug: r.shop_slug,
      name: r.shop_name,
      city: r.shop_city,
      state: r.shop_state,
      stateLabel: stateLabel(r.shop_state),
      area: r.shop_area,
      dispatchDays: r.dispatch_days,
      paused: r.shop_status === 'paused',
      verification: toVerificationView(r),
      reputation: toReputation(r),
      coverageSummary: describeCoverage(coverage, { state: r.shop_state, city: r.shop_city, area: r.shop_area }).summary,
    },
    isOwner,
    saved: saves.mine,
    saveCount: saves.n,
  };
}

/**
 * Counts a listing view once per viewer per day (viewer hash is derived from the session or a hashed
 * IP+user agent — never the raw IP). Owners' own views are not counted.
 */
export async function recordListingView(db: Queryable, args: { listingId: string; viewerKey: string; secret: string; isOwner: boolean }): Promise<boolean> {
  if (args.isOwner || !isUuid(args.listingId)) return false;
  const viewerHash = createHash('sha256').update(`${args.secret}:${args.viewerKey}`).digest('hex').slice(0, 32);
  const res = await db.query(
    `INSERT INTO listing_view_dedupe (listing_id, viewer_hash, day) VALUES ($1, $2, current_date) ON CONFLICT DO NOTHING`,
    [args.listingId, viewerHash],
  );
  if (!res.rowCount) return false;
  await db.query(
    `INSERT INTO listing_daily_stats (listing_id, day, views) VALUES ($1, current_date, 1)
     ON CONFLICT (listing_id, day) DO UPDATE SET views = listing_daily_stats.views + 1`,
    [args.listingId],
  );
  return true;
}

// ---------------------------------------------------------------------------
// Seller editor
// ---------------------------------------------------------------------------

export interface ListingEditView {
  id: string;
  status: string;
  statusLabel: string;
  isDraft: boolean;
  categoryId: string;
  categoryName: string;
  categoryRestricted: boolean;
  schema: AttributeSchema;
  schemaVersion: number;
  title: string;
  description: string;
  brand: string | null;
  colour: string | null;
  material: string | null;
  sizeSystem: SizeSystem | null;
  sizeLabel: string | null;
  measurements: Record<string, number>;
  attributes: Record<string, string>;
  condition: ConditionGrade | null;
  flawsDeclaration: 'none_known' | 'described' | null;
  flaws: { id: string; description: string; location: string | null; severity: 'minor' | 'moderate' | 'major'; mediaId: string | null }[];
  saleMode: SaleMode;
  priceMinor: number | null;
  /** Private: shown only to the owning seller. */
  minOfferMinor: number | null;
  quantityMode: 'unique' | 'equivalent';
  quantity: number;
  deliveryStates: string[];
  weightGrams: number | null;
  batchId: string | null;
  version: number;
  photos: { mediaId: string; role: MediaRole; caption: string | null; thumbUrl: string; url: string }[];
  stock: { total: number; available: number; reserved: number; sold: number; withdrawn: number } | null;
  auction: { id: string; status: string; bidCount: number } | null;
  hasActiveReservation: boolean;
  publishIssues: PublishIssue[];
  /** Field → reason it cannot be edited right now (published listings only). */
  locked: Partial<Record<'price' | 'saleMode' | 'condition' | 'photos' | 'quantity', string>>;
  batches: { id: string; name: string; dropAt: string | null }[];
  shopState: string;
  shopStatus: string;
}

export async function getListingForEdit(ctx: AppContext, listingId: string): Promise<ListingEditView> {
  const l = await loadOwnListing(ctx.pool, ctx, listingId);
  const { schema, version: schemaVersion } = await loadSchemaFor(ctx.pool, l.schema_version_id);
  const cat = await one<{ name: string; restricted: boolean }>(ctx.pool, 'SELECT name, restricted FROM categories WHERE id = $1', [l.category_id]);
  const photos = await many<{ media_id: string; role: MediaRole; caption: string | null; storage_key: string }>(
    ctx.pool,
    `SELECT lm.media_id, lm.role, lm.caption, m.storage_key FROM listing_media lm JOIN media_assets m ON m.id = lm.media_id
      WHERE lm.listing_id = $1 ORDER BY lm.position`,
    [l.id],
  );
  const flaws = await many<{ id: string; description: string; location: string | null; severity: 'minor' | 'moderate' | 'major'; media_id: string | null }>(
    ctx.pool,
    `SELECT id, description, location, severity, media_id FROM listing_flaws WHERE listing_id = $1 ORDER BY created_at, id`,
    [l.id],
  );
  const stock = await maybeOne<{ quantity_total: number; quantity_available: number; quantity_reserved: number; quantity_sold: number; quantity_withdrawn: number }>(
    ctx.pool,
    'SELECT quantity_total, quantity_available, quantity_reserved, quantity_sold, quantity_withdrawn FROM inventory_stock WHERE listing_id = $1',
    [l.id],
  );
  const auction = await maybeOne<{ id: string; status: string; bid_count: number }>(
    ctx.pool,
    `SELECT id, status, bid_count FROM auctions WHERE listing_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [l.id],
  );
  const reserved =
    (await maybeOne(ctx.pool, `SELECT 1 AS ok FROM reservations WHERE listing_id = $1 AND status IN ('active','payment_pending') LIMIT 1`, [l.id])) !== null;
  const batches = await many<{ id: string; name: string; drop_at: Date | null }>(
    ctx.pool,
    `SELECT id, name, drop_at FROM batches WHERE shop_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [l.shop_id],
  );
  const quantity = l.quantity_mode === 'unique' ? 1 : l.initial_quantity;
  const issues = l.status === 'draft' ? validateForPublish(await publishCandidate(ctx.pool, l, quantity), schema) : [];
  const locked: ListingEditView['locked'] = {};
  if (l.status !== 'draft') {
    for (const field of ['price', 'saleMode', 'condition', 'photos', 'quantity'] as const) {
      const reason = editRestriction({ status: l.status, hasActiveReservation: reserved, auctionHasBids: (auction?.bid_count ?? 0) > 0, field });
      if (reason) locked[field] = reason;
    }
    locked.quantity ??= 'Quantity is fixed after publishing. Use Restock (identical units) or Mark sold elsewhere.';
    if (l.sale_mode === 'auction') locked.saleMode ??= 'Auction pieces keep their sale mode. Manage the auction from the auctions page.';
  }
  return {
    id: l.id,
    status: l.status,
    statusLabel: LISTING_STATUS_LABEL[l.status] ?? l.status,
    isDraft: l.status === 'draft',
    categoryId: l.category_id,
    categoryName: cat.name,
    categoryRestricted: cat.restricted,
    schema,
    schemaVersion,
    title: l.title,
    description: l.description,
    brand: l.brand,
    colour: l.colour,
    material: l.material,
    sizeSystem: l.size_system,
    sizeLabel: l.size_label,
    measurements: l.measurements ?? {},
    attributes: l.attributes ?? {},
    condition: l.condition,
    flawsDeclaration: l.flaws_declaration,
    flaws: flaws.map((f) => ({ id: f.id, description: f.description, location: f.location, severity: f.severity, mediaId: f.media_id })),
    saleMode: l.sale_mode,
    priceMinor: l.price_minor,
    minOfferMinor: l.min_offer_minor,
    quantityMode: l.quantity_mode,
    quantity,
    deliveryStates: l.delivery_states ?? [],
    weightGrams: l.weight_grams,
    batchId: l.batch_id,
    version: l.version,
    photos: photos.map((p) => ({ mediaId: p.media_id, role: p.role, caption: p.caption, thumbUrl: mediaPath(p.storage_key, 'thumb'), url: mediaPath(p.storage_key) })),
    stock: stock
      ? { total: stock.quantity_total, available: stock.quantity_available, reserved: stock.quantity_reserved, sold: stock.quantity_sold, withdrawn: stock.quantity_withdrawn }
      : null,
    auction: auction ? { id: auction.id, status: auction.status, bidCount: auction.bid_count } : null,
    hasActiveReservation: reserved,
    publishIssues: issues,
    locked,
    batches: batches.map((b) => ({ id: b.id, name: b.name, dropAt: b.drop_at ? new Date(b.drop_at).toISOString() : null })),
    shopState: l.shop_state,
    shopStatus: l.shop_status,
  };
}

// ---------------------------------------------------------------------------
// Seller listings table
// ---------------------------------------------------------------------------

export type SellerListingFilter = 'all' | 'draft' | 'active' | 'scheduled' | 'reserved' | 'paused' | 'sold' | 'ended' | 'removed';

export interface SellerListingRow {
  id: string;
  title: string;
  status: string;
  statusLabel: string;
  saleMode: SaleMode;
  saleModeLabel: string;
  priceMinor: number | null;
  quantityMode: 'unique' | 'equivalent';
  quantityAvailable: number | null;
  quantityTotal: number | null;
  photoKey: string | null;
  views30d: number;
  saves: number;
  batchName: string | null;
  auctionId: string | null;
  auctionStatus: string | null;
  updatedAt: string;
}

export interface SellerListingsPage {
  rows: SellerListingRow[];
  counts: Record<SellerListingFilter, number>;
  nextCursor: string | null;
}

/** The seller's own listings, newest change first, with status filter, title search and keyset pagination. */
export async function sellerListings(
  ctx: AppContext,
  opts: { status?: string | null; q?: string | null; cursor?: string | null; limit?: number } = {},
): Promise<SellerListingsPage> {
  requireUser(ctx);
  const shop = await requireOwnShop(ctx.pool, ctx);
  const filter: SellerListingFilter = (['draft', 'active', 'scheduled', 'reserved', 'paused', 'sold', 'ended', 'removed'] as const).includes(opts.status as never)
    ? (opts.status as SellerListingFilter)
    : 'all';
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const params: unknown[] = [shop.id];
  const where = ['l.shop_id = $1'];
  if (filter === 'all') where.push(`l.status <> 'removed'`);
  else {
    params.push(filter);
    where.push(`l.status = $${params.length}`);
  }
  const q = opts.q?.trim();
  if (q) {
    params.push(`%${q.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    where.push(`lower(l.title) LIKE $${params.length}`);
  }
  const cursor = decodeEditCursor(opts.cursor);
  if (cursor) {
    params.push(cursor.updatedAt, cursor.id);
    where.push(`(l.updated_at, l.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(limit + 1);
  const rows = await many<{
    id: string;
    title: string;
    status: string;
    sale_mode: SaleMode;
    price_minor: number | null;
    quantity_mode: 'unique' | 'equivalent';
    quantity_available: number | null;
    quantity_total: number | null;
    photo_key: string | null;
    views_30d: number;
    saves: number;
    batch_name: string | null;
    auction_id: string | null;
    auction_status: string | null;
    updated_at: Date;
  }>(
    ctx.pool,
    `SELECT l.id, l.title, l.status, l.sale_mode, l.price_minor, l.quantity_mode, st.quantity_available, st.quantity_total,
            (SELECT m.storage_key FROM listing_media lm JOIN media_assets m ON m.id = lm.media_id WHERE lm.listing_id = l.id ORDER BY lm.position LIMIT 1) AS photo_key,
            coalesce((SELECT sum(views)::int FROM listing_daily_stats d WHERE d.listing_id = l.id AND d.day > current_date - 30), 0) AS views_30d,
            (SELECT count(*)::int FROM saved_items si WHERE si.listing_id = l.id) AS saves,
            b.name AS batch_name,
            a.id AS auction_id, a.status AS auction_status, l.updated_at
       FROM listings l
       LEFT JOIN inventory_stock st ON st.listing_id = l.id
       LEFT JOIN batches b ON b.id = l.batch_id
       LEFT JOIN LATERAL (SELECT id, status FROM auctions WHERE listing_id = l.id ORDER BY created_at DESC LIMIT 1) a ON true
      WHERE ${where.join(' AND ')}
      ORDER BY l.updated_at DESC, l.id DESC
      LIMIT $${params.length}`,
    params,
  );
  const countRows = await many<{ status: string; n: number }>(ctx.pool, `SELECT status, count(*)::int AS n FROM listings WHERE shop_id = $1 GROUP BY status`, [shop.id]);
  const counts = { all: 0, draft: 0, active: 0, scheduled: 0, reserved: 0, paused: 0, sold: 0, ended: 0, removed: 0 } as Record<SellerListingFilter, number>;
  for (const c of countRows) {
    if (c.status in counts) counts[c.status as SellerListingFilter] = c.n;
    if (c.status !== 'removed') counts.all += c.n;
  }
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      statusLabel: LISTING_STATUS_LABEL[r.status] ?? r.status,
      saleMode: r.sale_mode,
      saleModeLabel: SALE_MODE_LABEL[r.sale_mode],
      priceMinor: r.price_minor,
      quantityMode: r.quantity_mode,
      quantityAvailable: r.quantity_available,
      quantityTotal: r.quantity_total,
      photoKey: r.photo_key,
      views30d: r.views_30d,
      saves: r.saves,
      batchName: r.batch_name,
      auctionId: r.auction_id,
      auctionStatus: r.auction_status,
      updatedAt: new Date(r.updated_at).toISOString(),
    })),
    counts,
    nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify([new Date(last.updated_at).toISOString(), last.id])).toString('base64url') : null,
  };
}

function decodeEditCursor(cursor: string | null | undefined): { updatedAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const [updatedAt, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [string, string];
    if (Number.isNaN(Date.parse(updatedAt)) || !isUuid(id)) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}

/** Leaf categories (with parent names) for the "new listing" picker. */
export async function listListableCategories(db: Queryable): Promise<{ id: string; name: string; parentName: string; kind: string; restricted: boolean }[]> {
  return (
    await many<{ id: string; name: string; parent_name: string; kind: string; restricted: boolean }>(
      db,
      `SELECT c.id, c.name, p.name AS parent_name, c.kind, c.restricted
         FROM categories c JOIN categories p ON p.id = c.parent_id
        WHERE c.active AND p.active
          AND NOT EXISTS (SELECT 1 FROM categories ch WHERE ch.parent_id = c.id AND ch.active)
        ORDER BY p.sort_order, c.sort_order, c.name`,
    )
  ).map((c) => ({ id: c.id, name: c.name, parentName: c.parent_name, kind: c.kind, restricted: c.restricted }));
}
