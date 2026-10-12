import { listAuctionsInput } from '@thrift/contracts';
import {
  CONDITION_INFO,
  DomainError,
  formatNaira,
  minimumNextBid,
  suggestedIncrement,
  validateForPublish,
  type AuctionStatus,
  type ConditionGrade,
  type PublishIssue,
} from '@thrift/domain';
import { many, maybeOne } from '@thrift/database';
import { requireOwnShop } from '../core/authz';
import type { AppContext } from '../core/context';
import { getSettings } from '../core/settings';
import { parseInput } from '../core/validation';
import { LISTING_CARD_COLUMNS, LISTING_CARD_FROM, toListingCard, type ListingCard, type ListingCardRow } from '../catalogue/cards';
import { loadSchemaFor, publishCandidate, type ListingRow } from '../catalogue/internal';
import { quoteDeliveryOptions } from '../delivery/quote';
import { mediaPath } from '../media/media';
import { auctionLinks, isUuid, latestAuctionPolicy, readAuction, ruleSummary, type AuctionRow } from './shared';

export const AUCTION_STATUS_LABEL: Record<AuctionStatus, string> = {
  draft: 'Draft',
  scheduled: 'Upcoming',
  live: 'Live',
  ended_no_bids: 'Ended — no bids',
  awaiting_payment: 'Ended — awaiting winner’s payment',
  paid: 'Sold',
  failed_unpaid: 'Ended — winner didn’t pay',
  cancelled: 'Cancelled',
};

export interface AuctionBidView {
  seq: number;
  amountMinor: number;
  at: string;
  /** "You" for the viewer's own bids, otherwise a stable masked label ("Bidder 3"). Never a name or id. */
  bidderLabel: string;
  mine: boolean;
}

export interface AuctionView {
  id: string;
  listingId: string;
  status: AuctionStatus;
  /** Effective phase from server time (status can lag the clock until the worker runs). */
  phase: 'upcoming' | 'live' | 'ended';
  statusLabel: string;
  startsAt: string;
  endsAt: string;
  originalEndsAt: string;
  serverNow: string;
  extended: boolean;
  openingPriceMinor: number;
  incrementMinor: number;
  currentBidMinor: number | null;
  minimumNextBidMinor: number;
  bidCount: number;
  seq: number;
  rules: { extensionWindowSeconds: number; extensionSeconds: number; maxExtensionSeconds: number; winnerPaymentHours: number; lines: string[] };
  policy: { title: string; version: string; body: string } | null;
  listing: {
    title: string;
    photos: { url: string; thumbUrl: string; alt: string }[];
    conditionLabel: string | null;
    sizeLabel: string | null;
    flaws: { description: string; location: string | null; severity: string }[];
    shop: { name: string; slug: string; verified: boolean; city: string; state: string };
  };
  bids: AuctionBidView[];
  viewer: {
    signedIn: boolean;
    isSeller: boolean;
    isLeader: boolean;
    isWinner: boolean;
    hasBid: boolean;
    canBid: boolean;
    cannotBidReason: string | null;
    mustPay: { deadline: string; checkoutPath: string } | null;
    paid: boolean;
    secondChance: { offerId: string; amountMinor: number; expiresAt: string; status: string; checkoutPath: string | null } | null;
    delivery: { destination: string; options: { label: string; feeMinor: number; transitDaysMin: number; transitDaysMax: number }[] } | null;
  };
}

interface ListingSummaryRow {
  title: string;
  condition: ConditionGrade | null;
  size_label: string | null;
  shop_name: string;
  shop_slug: string;
  shop_status: string;
  verification_status: string;
  city: string;
  state: string;
  l_status: string;
  [k: string]: unknown;
}

/** Public auction snapshot for the page and its polling endpoint; viewer-specific fields only when signed in. */
export async function getAuctionView(ctx: AppContext, auctionId: string): Promise<AuctionView> {
  const a = await readAuction(ctx.pool, auctionId);
  if (!a || a.status === 'draft') throw new DomainError('NOT_FOUND', 'Auction not found.');
  const viewerId = ctx.actor.kind === 'user' ? ctx.actor.userId : null;
  const l = await maybeOne<ListingSummaryRow & { is_member: boolean }>(
    ctx.pool,
    `SELECT l.title, l.condition, l.size_label, l.status AS l_status, s.name AS shop_name, s.slug AS shop_slug, s.status AS shop_status,
            s.verification_status, s.city, s.state,
            EXISTS (SELECT 1 FROM shop_members m WHERE m.shop_id = s.id AND m.user_id = $2) AS is_member
       FROM listings l JOIN shops s ON s.id = l.shop_id WHERE l.id = $1`,
    [a.listing_id, viewerId],
  );
  if (!l || l.l_status === 'removed' || (!l.is_member && ['draft', 'suspended'].includes(l.shop_status))) throw new DomainError('NOT_FOUND', 'Auction not found.');
  const settings = await getSettings(ctx.pool);
  const now = ctx.now();
  const [photos, flaws, bidRows, policy] = await Promise.all([
    many<{ storage_key: string; alt_text: string | null }>(
      ctx.pool,
      `SELECT m.storage_key, m.alt_text FROM listing_media lm JOIN media_assets m ON m.id = lm.media_id WHERE lm.listing_id = $1 AND m.status = 'ready' ORDER BY lm.position LIMIT 12`,
      [a.listing_id],
    ),
    many<{ description: string; location: string | null; severity: string }>(
      ctx.pool,
      'SELECT description, location, severity FROM listing_flaws WHERE listing_id = $1 ORDER BY created_at, id',
      [a.listing_id],
    ),
    many<{ seq: number; amount_minor: number; created_at: Date; bidder_user_id: string; bidder_no: number }>(
      ctx.pool,
      `SELECT b.seq, b.amount_minor, b.created_at, b.bidder_user_id,
              dense_rank() OVER (ORDER BY f.first_seq)::int AS bidder_no
         FROM bids b
         JOIN (SELECT bidder_user_id, min(seq) AS first_seq FROM bids WHERE auction_id = $1 GROUP BY bidder_user_id) f ON f.bidder_user_id = b.bidder_user_id
        WHERE b.auction_id = $1
        ORDER BY b.seq DESC LIMIT 50`,
      [a.id],
    ),
    latestAuctionPolicy(ctx.pool, now),
  ]);
  const startsAt = new Date(a.starts_at);
  const endsAt = new Date(a.ends_at);
  const phase: AuctionView['phase'] =
    (a.status === 'live' || a.status === 'scheduled') && now < endsAt ? (now >= startsAt ? 'live' : 'upcoming') : 'ended';
  const viewer = await viewerState(ctx, a, viewerId, l.is_member, phase, bidRows.some((b) => b.bidder_user_id === viewerId));
  return {
    id: a.id,
    listingId: a.listing_id,
    status: a.status,
    phase,
    statusLabel: phase === 'ended' && (a.status === 'live' || a.status === 'scheduled') ? 'Ended — finalising' : AUCTION_STATUS_LABEL[a.status],
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    originalEndsAt: new Date(a.original_ends_at).toISOString(),
    serverNow: now.toISOString(),
    extended: endsAt.getTime() > new Date(a.original_ends_at).getTime(),
    openingPriceMinor: a.opening_price_minor,
    incrementMinor: a.increment_minor,
    currentBidMinor: a.current_bid_minor,
    minimumNextBidMinor: minimumNextBid({ currentBidMinor: a.current_bid_minor, openingPriceMinor: a.opening_price_minor, incrementMinor: a.increment_minor }),
    bidCount: a.bid_count,
    seq: a.seq,
    rules: {
      extensionWindowSeconds: a.extension_window_seconds,
      extensionSeconds: a.extension_seconds,
      maxExtensionSeconds: a.max_extension_seconds,
      winnerPaymentHours: settings.winner_payment_hours,
      lines: ruleSummary({
        openingPriceMinor: a.opening_price_minor,
        incrementMinor: a.increment_minor,
        extensionWindowSeconds: a.extension_window_seconds,
        extensionSeconds: a.extension_seconds,
        maxExtensionSeconds: a.max_extension_seconds,
        winnerPaymentHours: settings.winner_payment_hours,
        formatMoney: formatNaira,
      }),
    },
    policy: policy ? { title: policy.title, version: policy.version, body: policy.body } : null,
    listing: {
      title: l.title,
      photos: photos.map((p) => ({ url: mediaPath(p.storage_key), thumbUrl: mediaPath(p.storage_key, 'thumb'), alt: p.alt_text ?? l.title })),
      conditionLabel: l.condition ? CONDITION_INFO[l.condition].label : null,
      sizeLabel: l.size_label,
      flaws,
      shop: { name: l.shop_name, slug: l.shop_slug, verified: l.verification_status === 'approved', city: l.city, state: l.state },
    },
    bids: bidRows.map((b) => ({
      seq: b.seq,
      amountMinor: b.amount_minor,
      at: new Date(b.created_at).toISOString(),
      bidderLabel: b.bidder_user_id === viewerId ? 'You' : `Bidder ${b.bidder_no}`,
      mine: b.bidder_user_id === viewerId,
    })),
    viewer,
  };
}

async function viewerState(
  ctx: AppContext,
  a: AuctionRow,
  viewerId: string | null,
  isSeller: boolean,
  phase: AuctionView['phase'],
  hasBid: boolean,
): Promise<AuctionView['viewer']> {
  const base: AuctionView['viewer'] = {
    signedIn: viewerId !== null,
    isSeller,
    isLeader: false,
    isWinner: false,
    hasBid,
    canBid: false,
    cannotBidReason: null,
    mustPay: null,
    paid: false,
    secondChance: null,
    delivery: null,
  };
  if (!viewerId || ctx.actor.kind !== 'user') {
    return { ...base, cannotBidReason: phase === 'ended' ? 'This auction has ended.' : 'Sign in to bid.' };
  }
  base.isLeader = a.current_bidder_user_id === viewerId && phase !== 'ended';
  base.isWinner = a.winner_user_id === viewerId;
  if (base.isWinner && a.status === 'awaiting_payment' && a.payment_deadline_at) {
    const order = await maybeOne<{ payment_status: string }>(
      ctx.pool,
      `SELECT payment_status FROM orders WHERE reservation_id = $1 AND status <> 'cancelled' ORDER BY created_at DESC LIMIT 1`,
      [a.reservation_id],
    );
    base.paid = order?.payment_status === 'paid';
    if (!base.paid) base.mustPay = { deadline: new Date(a.payment_deadline_at).toISOString(), checkoutPath: auctionLinks.checkoutAuction(a.id) };
  }
  if (base.isWinner && a.status === 'paid') base.paid = true;
  const sc = await maybeOne<{ id: string; amount_minor: number; expires_at: Date; status: string; r_status: string | null }>(
    ctx.pool,
    `SELECT sc.id, sc.amount_minor, sc.expires_at, sc.status, r.status AS r_status
       FROM second_chance_offers sc LEFT JOIN reservations r ON r.id = sc.reservation_id
      WHERE sc.auction_id = $1 AND sc.bidder_user_id = $2 ORDER BY sc.created_at DESC LIMIT 1`,
    [a.id, viewerId],
  );
  if (sc) {
    base.secondChance = {
      offerId: sc.id,
      amountMinor: sc.amount_minor,
      expiresAt: new Date(sc.expires_at).toISOString(),
      status: sc.status,
      checkoutPath: sc.status === 'accepted' && ['active', 'payment_pending'].includes(sc.r_status ?? '') && a.status !== 'paid' ? auctionLinks.checkoutSecondChance(sc.id) : null,
    };
  }
  const addr = await maybeOne<{ city: string; state: string }>(
    ctx.pool,
    'SELECT city, state FROM addresses WHERE user_id = $1 AND archived_at IS NULL ORDER BY is_default DESC, created_at DESC LIMIT 1',
    [viewerId],
  );
  if (addr) {
    const options = await quoteDeliveryOptions(ctx.pool, { listingId: a.listing_id, destination: { state: addr.state, city: addr.city } });
    base.delivery = {
      destination: `${addr.city}, ${addr.state}`,
      options: options.map((o) => ({ label: o.label, feeMinor: o.feeMinor, transitDaysMin: o.transitDaysMin, transitDaysMax: o.transitDaysMax })),
    };
  }
  let reason: string | null = null;
  if (phase === 'ended') reason = 'This auction has ended.';
  else if (phase === 'upcoming') reason = 'Bidding opens when the auction starts.';
  else if (isSeller) reason = 'Sellers and their shop staff can’t bid on their own auctions.';
  else if (!ctx.actor.contactVerified) reason = 'Verify your email or phone number to bid.';
  else if (!addr) reason = 'Add a delivery address before bidding, so we can confirm this seller delivers to you.';
  else if (base.delivery && base.delivery.options.length === 0) reason = `This seller doesn’t deliver to ${base.delivery.destination}. Choose another address to bid.`;
  else if (base.isLeader) reason = 'You have the highest bid.';
  return { ...base, canBid: reason === null, cannotBidReason: reason };
}

export type AuctionListStatus = 'live' | 'upcoming' | 'ended';

const LIST_WHERE: Record<AuctionListStatus, string> = {
  live: `a.status IN ('live','scheduled') AND a.starts_at <= $1 AND a.ends_at > $1 AND l.status IN ('active','reserved','scheduled')`,
  upcoming: `a.status = 'scheduled' AND a.starts_at > $1 AND l.status IN ('scheduled','active')`,
  ended: `a.status IN ('ended_no_bids','awaiting_payment','paid') AND a.ends_at > $1::timestamptz - interval '30 days' AND l.status <> 'removed'`,
};
const LIST_ORDER: Record<AuctionListStatus, string> = {
  live: 'a.ends_at ASC, l.id',
  upcoming: 'a.starts_at ASC, l.id',
  ended: 'a.ends_at DESC, l.id',
};

/** Auction index: live (ending soonest first), upcoming (starting soonest) or recently ended. Offset paging. */
export async function listAuctions(ctx: AppContext, raw: unknown = {}): Promise<{ items: ListingCard[]; nextCursor: string | null; serverNow: string }> {
  const input = parseInput(listAuctionsInput, raw);
  const offset = Math.max(0, Math.min(10_000, Number.parseInt(Buffer.from(input.cursor ?? '', 'base64url').toString('utf8') || '0', 10) || 0));
  const rows = await many<ListingCardRow>(
    ctx.pool,
    `SELECT ${LISTING_CARD_COLUMNS} FROM ${LISTING_CARD_FROM}
      WHERE s.status = 'active' AND l.sale_mode = 'auction' AND ${LIST_WHERE[input.status]}
      ORDER BY ${LIST_ORDER[input.status]} LIMIT $2 OFFSET $3`,
    [ctx.now(), input.limit + 1, offset],
  );
  return {
    items: rows.slice(0, input.limit).map((r) => toListingCard(r)),
    nextCursor: rows.length > input.limit ? Buffer.from(String(offset + input.limit)).toString('base64url') : null,
    serverNow: ctx.now().toISOString(),
  };
}

export interface ShopAuctionItem {
  id: string;
  listingId: string;
  title: string;
  photoUrl: string | null;
  status: AuctionStatus;
  statusLabel: string;
  startsAt: string;
  endsAt: string;
  openingPriceMinor: number;
  currentBidMinor: number | null;
  bidCount: number;
  paymentDeadline: string | null;
  secondChance: { status: string; amountMinor: number; expiresAt: string } | null;
  canCancel: boolean;
  canOfferSecondChance: boolean;
  canRelist: boolean;
}

/** The seller's auctions, newest first, with the actions available for each. */
export async function shopAuctions(ctx: AppContext): Promise<{ items: ShopAuctionItem[]; serverNow: string }> {
  const shop = await requireOwnShop(ctx.pool, ctx);
  const rows = await many<
    AuctionRow & { title: string; l_status: string; photo_key: string | null; is_latest: boolean; runner_up: boolean; sc_status: string | null; sc_amount: number | null; sc_expires: Date | null; sc_active: boolean }
  >(
    ctx.pool,
    `SELECT a.*, l.title, l.status AS l_status,
            (SELECT m.storage_key FROM listing_media lm JOIN media_assets m ON m.id = lm.media_id WHERE lm.listing_id = l.id ORDER BY lm.position LIMIT 1) AS photo_key,
            NOT EXISTS (SELECT 1 FROM auctions n WHERE n.listing_id = a.listing_id AND n.created_at > a.created_at) AS is_latest,
            EXISTS (SELECT 1 FROM bids b WHERE b.auction_id = a.id AND b.bidder_user_id IS DISTINCT FROM a.winner_user_id
                     AND NOT EXISTS (SELECT 1 FROM second_chance_offers x WHERE x.auction_id = a.id AND x.bidder_user_id = b.bidder_user_id)) AS runner_up,
            sc.status AS sc_status, sc.amount_minor AS sc_amount, sc.expires_at AS sc_expires,
            (sc.status = 'pending' OR (sc.status = 'accepted' AND r.status IN ('active','payment_pending'))) AS sc_active
       FROM auctions a
       JOIN listings l ON l.id = a.listing_id
       LEFT JOIN LATERAL (SELECT * FROM second_chance_offers x WHERE x.auction_id = a.id ORDER BY x.created_at DESC LIMIT 1) sc ON true
       LEFT JOIN reservations r ON r.id = sc.reservation_id
      WHERE a.shop_id = $1
      ORDER BY a.created_at DESC LIMIT 100`,
    [shop.id],
  );
  return {
    items: rows.map((r) => ({
      id: r.id,
      listingId: r.listing_id,
      title: r.title,
      photoUrl: r.photo_key ? mediaPath(r.photo_key, 'thumb') : null,
      status: r.status,
      statusLabel: AUCTION_STATUS_LABEL[r.status],
      startsAt: new Date(r.starts_at).toISOString(),
      endsAt: new Date(r.ends_at).toISOString(),
      openingPriceMinor: r.opening_price_minor,
      currentBidMinor: r.current_bid_minor,
      bidCount: r.bid_count,
      paymentDeadline: r.payment_deadline_at ? new Date(r.payment_deadline_at).toISOString() : null,
      secondChance: r.sc_status ? { status: r.sc_status, amountMinor: r.sc_amount!, expiresAt: new Date(r.sc_expires!).toISOString() } : null,
      canCancel: r.bid_count === 0 && (r.status === 'scheduled' || r.status === 'live'),
      canOfferSecondChance: r.status === 'failed_unpaid' && r.runner_up && !r.sc_active && r.l_status === 'draft',
      canRelist: ['ended_no_bids', 'failed_unpaid', 'cancelled'].includes(r.status) && r.is_latest && !r.sc_active && ['draft', 'ended'].includes(r.l_status),
    })),
    serverNow: ctx.now().toISOString(),
  };
}

export interface AuctionScheduleContext {
  candidates: { id: string; title: string; photoUrl: string | null; saleMode: string }[];
  selected: {
    id: string;
    title: string;
    photoUrl: string | null;
    issues: PublishIssue[];
    suggestedIncrementMinor: number;
    referencePriceMinor: number | null;
  } | null;
  /** When relisting: the previous auction's terms as defaults. */
  relist: { auctionId: string; openingPriceMinor: number; incrementMinor: number } | null;
  rules: { extensionWindowSeconds: number; extensionSeconds: number; maxExtensionSeconds: number; winnerPaymentHours: number };
}

/** Data for the "schedule an auction" page: the seller's draft unique pieces and readiness of the chosen one. */
export async function getAuctionScheduleContext(ctx: AppContext, opts: { listingId?: string; relistAuctionId?: string } = {}): Promise<AuctionScheduleContext> {
  const shop = await requireOwnShop(ctx.pool, ctx);
  const settings = await getSettings(ctx.pool);
  const candidates = await many<{ id: string; title: string; sale_mode: string; photo_key: string | null }>(
    ctx.pool,
    `SELECT l.id, l.title, l.sale_mode,
            (SELECT m.storage_key FROM listing_media lm JOIN media_assets m ON m.id = lm.media_id WHERE lm.listing_id = l.id ORDER BY lm.position LIMIT 1) AS photo_key
       FROM listings l
      WHERE l.shop_id = $1 AND l.status = 'draft' AND l.quantity_mode = 'unique'
        AND NOT EXISTS (SELECT 1 FROM auctions a WHERE a.listing_id = l.id AND a.status IN ('draft','scheduled','live','awaiting_payment'))
      ORDER BY (l.sale_mode = 'auction') DESC, l.updated_at DESC LIMIT 100`,
    [shop.id],
  );
  let relist: AuctionScheduleContext['relist'] = null;
  let listingId = opts.listingId;
  if (opts.relistAuctionId && isUuid(opts.relistAuctionId)) {
    const prev = await readAuction(ctx.pool, opts.relistAuctionId);
    if (!prev || prev.shop_id !== shop.id) throw new DomainError('NOT_FOUND', 'Auction not found.');
    relist = { auctionId: prev.id, openingPriceMinor: prev.opening_price_minor, incrementMinor: prev.increment_minor };
    listingId = prev.listing_id;
  }
  let selected: AuctionScheduleContext['selected'] = null;
  if (listingId && isUuid(listingId)) {
    const l = await maybeOne<ListingRow & { photo_key: string | null }>(
      ctx.pool,
      `SELECT l.*, s.status AS shop_status, s.state AS shop_state, s.city AS shop_city,
              (SELECT m.storage_key FROM listing_media lm JOIN media_assets m ON m.id = lm.media_id WHERE lm.listing_id = l.id ORDER BY lm.position LIMIT 1) AS photo_key
         FROM listings l JOIN shops s ON s.id = l.shop_id WHERE l.id = $1 AND l.shop_id = $2`,
      [listingId, shop.id],
    );
    if (!l) throw new DomainError('NOT_FOUND', 'Listing not found.');
    const { schema } = await loadSchemaFor(ctx.pool, l.schema_version_id);
    const issues = validateForPublish(await publishCandidate(ctx.pool, { ...l, sale_mode: 'auction' }, 1), schema);
    if (!relist && l.status !== 'draft') issues.unshift({ field: 'status', message: 'Only draft pieces can be scheduled for auction.' });
    const reference = relist?.openingPriceMinor ?? l.price_minor ?? null;
    selected = {
      id: l.id,
      title: l.title,
      photoUrl: l.photo_key ? mediaPath(l.photo_key, 'thumb') : null,
      issues,
      suggestedIncrementMinor: relist?.incrementMinor ?? suggestedIncrement(reference ?? 500_000),
      referencePriceMinor: reference,
    };
  }
  return {
    candidates: candidates.map((c) => ({ id: c.id, title: c.title, photoUrl: c.photo_key ? mediaPath(c.photo_key, 'thumb') : null, saleMode: c.sale_mode })),
    selected,
    relist,
    rules: { extensionWindowSeconds: 120, extensionSeconds: 120, maxExtensionSeconds: 600, winnerPaymentHours: settings.winner_payment_hours },
  };
}
