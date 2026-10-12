import { AUCTION_STATUS, assertTransition, DomainError, type AuctionState, type AuctionStatus, type DeliveryOption } from '@thrift/domain';
import { maybeOne, type Queryable } from '@thrift/database';

/**
 * Shared internals of the auctions module.
 *
 * Lock order (AGENTS.md): auctions → offer_threads → inventory_stock → reservations → orders → payment_attempts → payouts.
 * second_chance_offers belong to the auction aggregate and are always locked AFTER their auction row.
 */

export interface AuctionRow {
  id: string;
  listing_id: string;
  shop_id: string;
  status: AuctionStatus;
  starts_at: Date;
  ends_at: Date;
  original_ends_at: Date;
  opening_price_minor: number;
  increment_minor: number;
  currency: string;
  extension_window_seconds: number;
  extension_seconds: number;
  max_extension_seconds: number;
  current_bid_minor: number | null;
  current_bid_id: string | null;
  current_bidder_user_id: string | null;
  bid_count: number;
  seq: number;
  winner_user_id: string | null;
  winning_bid_id: string | null;
  payment_deadline_at: Date | null;
  reservation_id: string | null;
  policy_version_id: string | null;
  finalized_at: Date | null;
  cancelled_reason: string | null;
  winner_delivery_quote: DeliveryQuoteSnapshot | null;
  relisted_from_id: string | null;
  created_at: Date;
  updated_at: Date;
  [k: string]: unknown;
}

/** Statuses in which an auction "owns" its listing (at most one per listing; partial unique index). */
export const OPEN_AUCTION_STATUSES = ['draft', 'scheduled', 'live', 'awaiting_payment'] as const;

/**
 * Auction lifecycle = domain machine + one module-level extension: a `failed_unpaid` auction can still end
 * `paid` when (a) a runner-up's explicitly accepted second-chance purchase is paid, or (b) the original winner's
 * late payment was verified and the inventory authority could re-allocate the still-free unit.
 */
export const AUCTION_LIFECYCLE: Readonly<Record<AuctionStatus, readonly AuctionStatus[]>> = {
  ...AUCTION_STATUS,
  failed_unpaid: ['paid'],
};

export function assertAuctionTransition(from: AuctionStatus, to: AuctionStatus): void {
  assertTransition(AUCTION_LIFECYCLE, from, to, 'auction status');
}

/** Delivery quote recorded with a bid (and copied to the auction for the winner). No street address. */
export interface DeliveryQuoteSnapshot {
  addressId: string | null;
  state: string;
  city: string;
  quotedAt: string;
  options: Pick<DeliveryOption, 'method' | 'label' | 'feeMinor' | 'transitDaysMin' | 'transitDaysMax' | 'dispatchDays'>[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

/**
 * In-app paths used in notifications. They mirror apps/web/src/lib/routes.ts (the application layer
 * cannot import web code); keep them in sync.
 */
export const auctionLinks = {
  auction: (auctionId: string) => `/auctions/${auctionId}`,
  checkoutAuction: (auctionId: string) => `/checkout/new?auction=${auctionId}`,
  checkoutSecondChance: (offerId: string) => `/checkout/new?secondChance=${offerId}`,
  sellAuctions: '/sell/auctions',
  addresses: '/account/addresses',
} as const;

export async function lockAuction(tx: Queryable, auctionId: string): Promise<AuctionRow> {
  if (!isUuid(auctionId)) throw new DomainError('NOT_FOUND', 'Auction not found.');
  const row = await maybeOne<AuctionRow>(tx, 'SELECT * FROM auctions WHERE id = $1 FOR UPDATE', [auctionId]);
  if (!row) throw new DomainError('NOT_FOUND', 'Auction not found.');
  return row;
}

export async function readAuction(db: Queryable, auctionId: string): Promise<AuctionRow | null> {
  if (!isUuid(auctionId)) return null;
  return maybeOne<AuctionRow>(db, 'SELECT * FROM auctions WHERE id = $1', [auctionId]);
}

export function toAuctionState(a: AuctionRow, sellerUserId: string): AuctionState {
  return {
    status: a.status,
    startsAt: new Date(a.starts_at),
    endsAt: new Date(a.ends_at),
    originalEndsAt: new Date(a.original_ends_at),
    currentBidMinor: a.current_bid_minor,
    currentBidderId: a.current_bidder_user_id,
    sellerUserId,
    openingPriceMinor: a.opening_price_minor,
    incrementMinor: a.increment_minor,
    extensionWindowSeconds: a.extension_window_seconds,
    extensionSeconds: a.extension_seconds,
    maxExtensionSeconds: a.max_extension_seconds,
  };
}

export type AuctionEventKind =
  | 'scheduled'
  | 'started'
  | 'bid'
  | 'extended'
  | 'ended'
  | 'winner_allocated'
  | 'payment_received'
  | 'failed_unpaid'
  | 'second_chance_offered'
  | 'second_chance_accepted'
  | 'second_chance_declined'
  | 'second_chance_expired'
  | 'cancelled'
  | 'relisted';

/** Appends to the auction's persisted event log (seq = the auction's bid sequence at that moment). */
export async function addAuctionEvent(tx: Queryable, args: { auctionId: string; seq: number; kind: AuctionEventKind; at: Date; data?: Record<string, unknown> }): Promise<void> {
  await tx.query(`INSERT INTO auction_events (auction_id, seq, kind, data, created_at) VALUES ($1, $2, $3, $4, $5)`, [
    args.auctionId,
    args.seq,
    args.kind,
    JSON.stringify(args.data ?? {}),
    args.at,
  ]);
}

export async function listingTitle(db: Queryable, listingId: string): Promise<string> {
  const r = await maybeOne<{ title: string }>(db, 'SELECT title FROM listings WHERE id = $1', [listingId]);
  return r?.title ?? 'your item';
}

export async function shopOwnerId(db: Queryable, shopId: string): Promise<string> {
  const r = await maybeOne<{ owner_user_id: string }>(db, 'SELECT owner_user_id FROM shops WHERE id = $1', [shopId]);
  if (!r) throw new DomainError('NOT_FOUND', 'Shop not found.');
  return r.owner_user_id;
}

export async function isShopMember(db: Queryable, shopId: string, userId: string): Promise<boolean> {
  const r = await maybeOne(db, 'SELECT 1 AS ok FROM shop_members WHERE shop_id = $1 AND user_id = $2', [shopId, userId]);
  return r !== null;
}

export interface AuctionPolicy {
  id: string;
  version: string;
  title: string;
  body: string;
}

export async function latestAuctionPolicy(db: Queryable, now: Date): Promise<AuctionPolicy | null> {
  return maybeOne<AuctionPolicy & Record<string, unknown>>(
    db,
    `SELECT id, version, title, body FROM policy_versions
      WHERE kind = 'auction_rules' AND effective_at <= $1 ORDER BY effective_at DESC LIMIT 1`,
    [now],
  );
}

/** Plain-language rule lines derived from the auction's own persisted numbers (shown before bidding). */
export function ruleSummary(a: {
  openingPriceMinor: number;
  incrementMinor: number;
  extensionWindowSeconds: number;
  extensionSeconds: number;
  maxExtensionSeconds: number;
  winnerPaymentHours: number;
  formatMoney: (minor: number) => string;
}): string[] {
  const mins = (s: number) => (s % 60 === 0 ? `${s / 60} minute${s === 60 ? '' : 's'}` : `${s} seconds`);
  return [
    `Opening price ${a.formatMoney(a.openingPriceMinor)} is the seller’s minimum. There is no hidden reserve.`,
    `Each bid must be at least the current bid plus ${a.formatMoney(a.incrementMinor)}.`,
    `A bid in the final ${mins(a.extensionWindowSeconds)} extends the end to ${mins(a.extensionSeconds)} after that bid, up to ${mins(a.maxExtensionSeconds)} in total.`,
    'Server time decides whether a bid counts. Times are shown in West Africa Time (WAT).',
    `A bid is a commitment to buy, not a payment. The winner pays within ${a.winnerPaymentHours} hours at checkout.`,
    'Bids are for the item only; delivery is charged separately and checked for your address.',
    'Sellers and their shop staff cannot bid. Bids cannot be withdrawn.',
  ];
}
