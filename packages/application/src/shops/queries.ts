import {
  DomainError,
  REPUTATION_THRESHOLDS,
  REPUTATION_TIER_LABEL,
  stateLabel,
  type ReputationTier,
  type ShopCoverage,
} from '@thrift/domain';
import { many, maybeOne, one, type Queryable } from '@thrift/database';
import { findOwnShop, requireOwnShop, requireUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { LISTING_CARD_COLUMNS, LISTING_CARD_FROM, toListingCard, type ListingCard, type ListingCardRow } from '../catalogue/cards';
import { computeChecklist, type OnboardingChecklist } from './checklist';
import { VERIFICATION_EXPLAINER } from './verification';

function listJoin(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Plain-language coverage, e.g. "Delivers nationwide · Seller-arranged and platform courier". */
export function describeCoverage(cov: ShopCoverage, shop: { state: string; city: string; area: string | null }): { areaText: string; methodsText: string; summary: string } {
  const except = cov.excludedStates.length > 0 ? ` except ${listJoin(cov.excludedStates.map(stateLabel))}` : '';
  const areaText =
    cov.scope === 'national'
      ? `Delivers nationwide${except}`
      : cov.scope === 'states'
        ? `Delivers to ${listJoin([shop.state, ...cov.states.filter((s) => s !== shop.state)].map(stateLabel))}${except}`
        : `Delivers within ${stateLabel(shop.state)}`;
  const methods: string[] = [];
  if (cov.offersSellerArranged) methods.push('seller-arranged');
  if (cov.offersIntegrated) methods.push('platform courier');
  if (cov.offersPickup) methods.push(`pickup in ${shop.area ?? shop.city}`);
  const joined = listJoin(methods);
  const methodsText = joined ? joined.charAt(0).toUpperCase() + joined.slice(1) : 'No delivery methods set';
  return { areaText, methodsText, summary: `${areaText} · ${methodsText}` };
}

interface CoverageDbRow {
  scope: ShopCoverage['scope'] | null;
  states: string[] | null;
  excluded_states: string[] | null;
  offers_pickup: boolean | null;
  offers_seller_arranged: boolean | null;
  offers_integrated: boolean | null;
  same_city_fee_minor: number | null;
  same_state_fee_minor: number | null;
  interstate_fee_minor: number | null;
  transit_days_min: number | null;
  transit_days_max: number | null;
  coverage_updated_at?: Date | null;
  [k: string]: unknown;
}

export function toCoverage(r: CoverageDbRow): ShopCoverage {
  return {
    scope: r.scope ?? 'local',
    states: r.states ?? [],
    excludedStates: r.excluded_states ?? [],
    offersPickup: r.offers_pickup ?? false,
    offersSellerArranged: r.offers_seller_arranged ?? true,
    offersIntegrated: r.offers_integrated ?? false,
    sameCityFeeMinor: r.same_city_fee_minor ?? 150_000,
    sameStateFeeMinor: r.same_state_fee_minor ?? 250_000,
    interstateFeeMinor: r.interstate_fee_minor ?? 450_000,
    transitDaysMin: r.transit_days_min ?? 1,
    transitDaysMax: r.transit_days_max ?? 5,
  };
}

const COVERAGE_COLUMNS = `c.scope, c.states, c.excluded_states, c.offers_pickup, c.offers_seller_arranged, c.offers_integrated,
  c.same_city_fee_minor, c.same_state_fee_minor, c.interstate_fee_minor, c.transit_days_min, c.transit_days_max, c.updated_at AS coverage_updated_at`;

export interface ReputationView {
  tier: ReputationTier;
  tierLabel: string;
  completedOrders: number;
  reviewCount: number;
  ratingAvg: number | null;
  /** True while the sample is too small to judge service (shown as "New seller"). */
  isNew: boolean;
  sampleText: string;
}

export function toReputation(r: { reputation_tier: ReputationTier; completed_orders: number; review_count: number; rating_avg: number | null }): ReputationView {
  const isNew = r.completed_orders < REPUTATION_THRESHOLDS.establishedMinOrders && r.reputation_tier !== 'under_review';
  const orders = `${r.completed_orders} completed ${r.completed_orders === 1 ? 'order' : 'orders'}`;
  const reviews = `${r.review_count} ${r.review_count === 1 ? 'review' : 'reviews'}`;
  return {
    tier: r.reputation_tier,
    tierLabel: isNew ? REPUTATION_TIER_LABEL.new : REPUTATION_TIER_LABEL[r.reputation_tier],
    completedOrders: r.completed_orders,
    reviewCount: r.review_count,
    ratingAvg: r.rating_avg,
    isNew,
    sampleText: r.rating_avg !== null && r.review_count > 0 ? `${r.rating_avg.toFixed(1)} average from ${reviews} · ${orders}` : `${orders} · ${reviews}`,
  };
}

export interface VerificationView {
  status: string;
  verified: boolean;
  label: string | null;
  verifiedAt: string | null;
  explanation: string;
}

export function toVerificationView(r: { verification_status: string; verification_label: string | null; verified_at: Date | null }): VerificationView {
  const verified = r.verification_status === 'approved';
  const explanation = verified
    ? `${r.verification_label ?? 'Identity checked'}. ${VERIFICATION_EXPLAINER}`
    : r.verification_status === 'pending'
      ? 'An identity check is in progress. Until it is complete, rely on the service history and reviews.'
      : 'This shop has not completed an identity check yet. Rely on the service history, reviews and photos.';
  return {
    status: r.verification_status,
    verified,
    label: verified ? (r.verification_label ?? 'Identity checked') : null,
    verifiedAt: r.verified_at ? new Date(r.verified_at).toISOString() : null,
    explanation,
  };
}

export async function getOnboardingChecklist(ctx: AppContext): Promise<OnboardingChecklist | null> {
  const user = requireUser(ctx);
  const shop = await findOwnShop(ctx.pool, user.userId);
  return shop ? computeChecklist(ctx.pool, shop.id) : null;
}

// ---------------------------------------------------------------------------
// Public storefront
// ---------------------------------------------------------------------------

export interface ShopStorefront {
  id: string;
  slug: string;
  name: string;
  bio: string;
  status: 'active' | 'paused' | 'draft' | 'suspended';
  paused: boolean;
  pausedNotice: string | null;
  city: string;
  state: string;
  stateLabel: string;
  area: string | null;
  locationText: string;
  pickupNote: string | null;
  returnsPolicy: string;
  dispatchDays: number;
  memberSince: string | null;
  verification: VerificationView;
  reputation: ReputationView;
  followerCount: number;
  viewerFollows: boolean;
  isOwner: boolean;
  coverage: ShopCoverage & { summary: string; areaText: string; methodsText: string };
  upcomingDrops: { batchId: string; name: string; dropAt: string; pieces: number }[];
  listings: ListingCard[];
  activeCount: number;
  nextCursor: string | null;
}

function encodeCursor(publishedAt: Date | null, id: string): string {
  return Buffer.from(JSON.stringify([publishedAt ? new Date(publishedAt).toISOString() : null, id])).toString('base64url');
}

function decodeCursor(cursor: string | null | undefined): { publishedAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const [publishedAt, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [string, string];
    if (typeof publishedAt !== 'string' || Number.isNaN(Date.parse(publishedAt)) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    return { publishedAt, id };
  } catch {
    return null;
  }
}

/**
 * Public shop page. Draft and suspended shops are visible only to their owner (others get NOT_FOUND).
 * Paused shops stay visible with a notice; their items cannot be bought until the shop resumes.
 */
export async function getShopStorefront(ctx: AppContext, slug: string, cursor?: string | null, limit = 24): Promise<ShopStorefront> {
  if (!/^[a-z0-9-]{3,40}$/.test(slug)) throw new DomainError('NOT_FOUND', 'Shop not found.');
  const s = await maybeOne<
    {
      id: string;
      slug: string;
      name: string;
      bio: string;
      status: ShopStorefront['status'];
      city: string;
      state: string;
      area: string | null;
      pickup_note: string | null;
      returns_policy: string;
      dispatch_days: number;
      published_at: Date | null;
      verification_status: string;
      verification_label: string | null;
      verified_at: Date | null;
      reputation_tier: ReputationTier;
      completed_orders: number;
      review_count: number;
      rating_avg: number | null;
      follower_count: number;
      owner_user_id: string;
    } & CoverageDbRow
  >(
    ctx.pool,
    `SELECT s.id, s.slug, s.name, s.bio, s.status, s.city, s.state, s.area, s.pickup_note, s.returns_policy, s.dispatch_days, s.published_at,
            s.verification_status, s.verification_label, s.verified_at, s.reputation_tier, s.completed_orders, s.review_count, s.rating_avg,
            s.follower_count, s.owner_user_id, ${COVERAGE_COLUMNS}
       FROM shops s LEFT JOIN delivery_coverage c ON c.shop_id = s.id
      WHERE s.slug = $1`,
    [slug],
  );
  if (!s) throw new DomainError('NOT_FOUND', 'Shop not found.');
  const viewerId = ctx.actor.kind === 'user' ? ctx.actor.userId : null;
  const isOwner = viewerId !== null && (viewerId === s.owner_user_id || Boolean(await maybeOne(ctx.pool, `SELECT 1 AS ok FROM shop_members WHERE shop_id = $1 AND user_id = $2`, [s.id, viewerId])));
  if ((s.status === 'draft' || s.status === 'suspended') && !isOwner) throw new DomainError('NOT_FOUND', 'Shop not found.');
  const viewerFollows = viewerId ? Boolean(await maybeOne(ctx.pool, `SELECT 1 AS ok FROM follows WHERE user_id = $1 AND shop_id = $2`, [viewerId, s.id])) : false;
  const cov = toCoverage(s);
  const words = describeCoverage(cov, s);
  const pageSize = Math.min(Math.max(limit, 1), 48);
  const c = decodeCursor(cursor);
  const params: unknown[] = [s.id, pageSize + 1];
  let cursorSql = '';
  if (c) {
    params.push(c.publishedAt, c.id);
    cursorSql = `AND (coalesce(l.published_at, l.created_at), l.id) < ($3::timestamptz, $4::uuid)`;
  }
  const rows = await many<ListingCardRow>(
    ctx.pool,
    `SELECT ${LISTING_CARD_COLUMNS}, coalesce(l.published_at, l.created_at) AS sort_at
       FROM ${LISTING_CARD_FROM}
      WHERE l.shop_id = $1 AND l.status IN ('active','reserved') ${cursorSql}
      ORDER BY coalesce(l.published_at, l.created_at) DESC, l.id DESC
      LIMIT $2`,
    params,
  );
  const page = rows.slice(0, pageSize);
  const last = page[page.length - 1];
  const activeCount = (await one<{ n: number }>(ctx.pool, `SELECT count(*)::int AS n FROM listings WHERE shop_id = $1 AND status IN ('active','reserved')`, [s.id])).n;
  const drops = await many<{ id: string; name: string; drop_at: Date; pieces: number }>(
    ctx.pool,
    `SELECT b.id, b.name, b.drop_at, count(l.id)::int AS pieces
       FROM batches b JOIN listings l ON l.batch_id = b.id AND l.status = 'scheduled'
      WHERE b.shop_id = $1 AND b.drop_at > $2 AND b.drop_announced_at IS NULL
      GROUP BY b.id ORDER BY b.drop_at LIMIT 3`,
    [s.id, ctx.now()],
  );
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    bio: s.bio,
    status: s.status,
    paused: s.status === 'paused',
    pausedNotice: s.status === 'paused' ? 'This shop is paused and is not taking new orders right now. You can still browse and follow it.' : null,
    city: s.city,
    state: s.state,
    stateLabel: stateLabel(s.state),
    area: s.area,
    locationText: [s.area, s.city, s.state === 'FCT' ? 'FCT' : s.state].filter(Boolean).join(', '),
    pickupNote: cov.offersPickup ? s.pickup_note : null,
    returnsPolicy: s.returns_policy,
    dispatchDays: s.dispatch_days,
    memberSince: s.published_at ? new Date(s.published_at).toISOString() : null,
    verification: toVerificationView(s),
    reputation: toReputation(s),
    followerCount: s.follower_count,
    viewerFollows,
    isOwner,
    coverage: { ...cov, ...words },
    upcomingDrops: drops.map((d) => ({ batchId: d.id, name: d.name, dropAt: new Date(d.drop_at).toISOString(), pieces: d.pieces })),
    listings: page.map((r) => toListingCard(r)),
    activeCount,
    nextCursor: rows.length > pageSize && last ? encodeCursor((last.sort_at as Date) ?? null, last.id) : null,
  };
}

// ---------------------------------------------------------------------------
// Seller workspace
// ---------------------------------------------------------------------------

export interface SellerOverview {
  shop: { id: string; slug: string; name: string; status: string; verificationStatus: string };
  checklist: OnboardingChecklist;
  counts: { drafts: number; active: number; scheduled: number; reserved: number; paused: number; sold: number; ended: number };
  pendingOffers: number;
  ordersToShip: number;
  payouts: { heldMinor: number; eligibleMinor: number; heldCount: number; eligibleCount: number };
  nextActions: {
    listingId: string;
    title: string;
    detail: string;
    saleMode: 'fixed' | 'negotiable' | 'auction';
    status: string;
    statusLabel: string;
    nextAction: string;
    nextActionKind: 'finish_draft' | 'review_offers' | 'view_auction' | 'ship_order' | 'awaiting_payment' | 'resume' | 'share' | 'restock' | 'none';
    auctionId: string | null;
    orderId: string | null;
    updatedAt: string;
  }[];
}

export const LISTING_STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled drop',
  active: 'Available',
  reserved: 'Reserved',
  sold: 'Sold',
  paused: 'Paused',
  ended: 'Ended',
  removed: 'Removed',
};

/** Read-only counts for the seller overview. Financial states (held vs eligible) stay separate. */
export async function getSellerOverview(ctx: AppContext): Promise<SellerOverview | null> {
  const user = requireUser(ctx);
  const own = await findOwnShop(ctx.pool, user.userId);
  if (!own) return null;
  return loadOverview(ctx.pool, ctx, own.id);
}

async function loadOverview(db: Queryable, ctx: AppContext, shopId: string): Promise<SellerOverview> {
  const shop = await one<{ id: string; slug: string; name: string; status: string; verification_status: string }>(
    db,
    `SELECT id, slug, name, status, verification_status FROM shops WHERE id = $1`,
    [shopId],
  );
  const counts = await many<{ status: string; n: number }>(db, `SELECT status, count(*)::int AS n FROM listings WHERE shop_id = $1 GROUP BY status`, [shopId]);
  const c = (s: string) => counts.find((r) => r.status === s)?.n ?? 0;
  const offers = await one<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM offers o JOIN offer_threads t ON t.id = o.thread_id
      WHERE t.shop_id = $1 AND t.status = 'open' AND o.status = 'pending' AND o.from_party = 'buyer'`,
    [shopId],
  );
  const toShip = await one<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM orders
      WHERE shop_id = $1 AND status = 'confirmed' AND payment_status = 'paid' AND fulfilment_status IN ('unfulfilled','awaiting_dispatch')`,
    [shopId],
  );
  const payouts = await one<{ held: number; eligible: number; held_n: number; eligible_n: number }>(
    db,
    `SELECT coalesce(sum(amount_minor) FILTER (WHERE status IN ('held','blocked')), 0)::bigint AS held,
            coalesce(sum(amount_minor) FILTER (WHERE status IN ('eligible','processing')), 0)::bigint AS eligible,
            count(*) FILTER (WHERE status IN ('held','blocked'))::int AS held_n,
            count(*) FILTER (WHERE status IN ('eligible','processing'))::int AS eligible_n
       FROM payouts WHERE shop_id = $1`,
    [shopId],
  );
  const rows = await many<{
    id: string;
    title: string;
    status: string;
    sale_mode: 'fixed' | 'negotiable' | 'auction';
    size_label: string | null;
    quantity_mode: string;
    quantity_available: number | null;
    updated_at: Date;
    pending_offers: number;
    auction_id: string | null;
    auction_status: string | null;
    auction_starts_at: Date | null;
    auction_ends_at: Date | null;
    ship_order_id: string | null;
  }>(
    db,
    `SELECT l.id, l.title, l.status, l.sale_mode, l.size_label, l.quantity_mode, st.quantity_available, l.updated_at,
            (SELECT count(*)::int FROM offers o JOIN offer_threads t ON t.id = o.thread_id
              WHERE t.listing_id = l.id AND t.status = 'open' AND o.status = 'pending' AND o.from_party = 'buyer') AS pending_offers,
            a.id AS auction_id, a.status AS auction_status, a.starts_at AS auction_starts_at, a.ends_at AS auction_ends_at,
            (SELECT o.id FROM order_items oi JOIN orders o ON o.id = oi.order_id
              WHERE oi.listing_id = l.id AND o.status = 'confirmed' AND o.payment_status = 'paid' AND o.fulfilment_status IN ('unfulfilled','awaiting_dispatch')
              ORDER BY o.created_at LIMIT 1) AS ship_order_id
       FROM listings l LEFT JOIN inventory_stock st ON st.listing_id = l.id LEFT JOIN LATERAL (SELECT * FROM auctions ax WHERE ax.listing_id = l.id ORDER BY ax.created_at DESC LIMIT 1) a ON true
      WHERE l.shop_id = $1 AND l.status <> 'removed'
      ORDER BY (CASE WHEN l.status IN ('draft','reserved','paused') THEN 0 ELSE 1 END), l.updated_at DESC
      LIMIT 8`,
    [shopId],
  );
  const now = ctx.now().getTime();
  const nextActions: SellerOverview['nextActions'] = rows.map((r) => {
    let nextAction = 'Share';
    let kind: SellerOverview['nextActions'][number]['nextActionKind'] = 'share';
    let statusLabel = LISTING_STATUS_LABEL[r.status] ?? r.status;
    if (r.ship_order_id) {
      nextAction = 'Ship order';
      kind = 'ship_order';
      statusLabel = 'Paid · to ship';
    } else if (r.status === 'draft') {
      nextAction = r.sale_mode === 'auction' ? 'Finish details, then schedule' : 'Finish draft';
      kind = 'finish_draft';
    } else if (r.auction_id && r.auction_status) {
      kind = 'view_auction';
      if (r.auction_status === 'scheduled' && r.auction_starts_at) {
        statusLabel = 'Auction scheduled';
        nextAction = 'View schedule';
      } else if (r.auction_status === 'live') {
        statusLabel = r.auction_ends_at && new Date(r.auction_ends_at).getTime() > now ? 'Auction live' : 'Auction ending';
        nextAction = 'Watch auction';
      } else {
        nextAction = 'View auction';
      }
    } else if (r.pending_offers > 0) {
      nextAction = `Review ${r.pending_offers === 1 ? 'offer' : `${r.pending_offers} offers`}`;
      kind = 'review_offers';
    } else if (r.status === 'reserved') {
      nextAction = 'Awaiting buyer payment';
      kind = 'awaiting_payment';
    } else if (r.status === 'paused') {
      nextAction = 'Resume';
      kind = 'resume';
    } else if (r.status === 'ended' && r.quantity_mode === 'equivalent') {
      nextAction = 'Restock';
      kind = 'restock';
    } else if (r.status === 'sold' || r.status === 'ended') {
      nextAction = '—';
      kind = 'none';
    }
    const detail = [r.size_label, r.quantity_mode === 'equivalent' ? `${r.quantity_available ?? 0} available` : '1 piece'].filter(Boolean).join(' / ');
    return {
      listingId: r.id,
      title: r.title,
      detail,
      saleMode: r.sale_mode,
      status: r.status,
      statusLabel,
      nextAction,
      nextActionKind: kind,
      auctionId: r.auction_id,
      orderId: r.ship_order_id,
      updatedAt: new Date(r.updated_at).toISOString(),
    };
  });
  return {
    shop: { id: shop.id, slug: shop.slug, name: shop.name, status: shop.status, verificationStatus: shop.verification_status },
    checklist: await computeChecklist(db, shopId),
    counts: { drafts: c('draft'), active: c('active'), scheduled: c('scheduled'), reserved: c('reserved'), paused: c('paused'), sold: c('sold'), ended: c('ended') },
    pendingOffers: offers.n,
    ordersToShip: toShip.n,
    payouts: { heldMinor: payouts.held, eligibleMinor: payouts.eligible, heldCount: payouts.held_n, eligibleCount: payouts.eligible_n },
    nextActions,
  };
}

export interface ShopSettingsView {
  id: string;
  slug: string;
  name: string;
  bio: string;
  status: 'draft' | 'active' | 'paused' | 'suspended';
  statusReason: string | null;
  city: string;
  state: string;
  area: string | null;
  locationPrecision: string;
  dispatchDays: number;
  returnsPolicy: string;
  pickupNote: string | null;
  coverage: ShopCoverage & { summary: string; confirmed: boolean };
  checklist: OnboardingChecklist;
}

export async function getShopSettings(ctx: AppContext): Promise<ShopSettingsView> {
  const own = await requireOwnShop(ctx.pool, ctx);
  const s = await one<
    {
      id: string;
      slug: string;
      name: string;
      bio: string;
      status: ShopSettingsView['status'];
      status_reason: string | null;
      city: string;
      state: string;
      area: string | null;
      location_precision: string;
      dispatch_days: number;
      returns_policy: string;
      pickup_note: string | null;
      created_at: Date;
    } & CoverageDbRow
  >(
    ctx.pool,
    `SELECT s.id, s.slug, s.name, s.bio, s.status, s.status_reason, s.city, s.state, s.area, s.location_precision, s.dispatch_days,
            s.returns_policy, s.pickup_note, s.created_at, ${COVERAGE_COLUMNS}
       FROM shops s LEFT JOIN delivery_coverage c ON c.shop_id = s.id WHERE s.id = $1`,
    [own.id],
  );
  const cov = toCoverage(s);
  const checklist = await computeChecklist(ctx.pool, s.id);
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    bio: s.bio,
    status: s.status,
    statusReason: s.status_reason,
    city: s.city,
    state: s.state,
    area: s.area,
    locationPrecision: s.location_precision,
    dispatchDays: s.dispatch_days,
    returnsPolicy: s.returns_policy,
    pickupNote: s.pickup_note,
    coverage: { ...cov, summary: describeCoverage(cov, s).summary, confirmed: checklist.items.find((i) => i.key === 'coverage')?.done ?? false },
    checklist,
  };
}
