import { cancelAuctionInput, createAuctionInput, relistAuctionInput } from '@thrift/contracts';
import { assertPublishable, DEFAULT_AUCTION_RULES, DomainError, validateAuctionSchedule } from '@thrift/domain';
import { many, maybeOne, one, withTransaction, type Queryable } from '@thrift/database';
import { recordAudit } from '../core/audit';
import { requireUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { enqueue } from '../core/outbox';
import { parseInput } from '../core/validation';
import { loadOwnListing, loadSchemaFor, publishCandidate, writeVersionIfChanged } from '../catalogue/internal';
import { initialiseStock, lockStock, restock, withdrawStock } from '../inventory/authority';
import { notifyUser } from '../notifications/notify';
import { addAuctionEvent, assertAuctionTransition, auctionLinks, isShopMember, latestAuctionPolicy, listingTitle, lockAuction, OPEN_AUCTION_STATUSES, type AuctionRow } from './shared';

/** True when the listing's current auction has at least one bid (terms and buyer-visible details are then frozen). */
export async function auctionHasBids(db: Queryable, listingId: string): Promise<boolean> {
  const r = await maybeOne<{ bid_count: number }>(
    db,
    `SELECT bid_count FROM auctions WHERE listing_id = $1 AND status = ANY($2::text[]) ORDER BY created_at DESC LIMIT 1`,
    [listingId, [...OPEN_AUCTION_STATUSES]],
  );
  return (r?.bid_count ?? 0) > 0;
}

/** Makes sure exactly one unit is available for the auction, through the inventory authority. */
async function ensureOneAvailableUnit(tx: Queryable, listingId: string, actorUserId: string): Promise<void> {
  const exists = await maybeOne(tx, 'SELECT 1 AS ok FROM inventory_stock WHERE listing_id = $1', [listingId]);
  if (!exists) {
    await initialiseStock(tx, listingId, 1);
    return;
  }
  const stock = await lockStock(tx, listingId);
  if (stock.quantityReserved > 0 || stock.quantitySold > 0) {
    throw new DomainError('INVALID_STATE', 'This piece is reserved or sold, so it can’t be auctioned now.');
  }
  if (stock.quantityAvailable > 1) throw new DomainError('INVALID_STATE', 'Auctions cover one identified piece.');
  if (stock.quantityAvailable === 0) await restock(tx, { listingId, quantity: 1, actorUserId });
}

interface ScheduleArgs {
  listingId: string;
  shopId: string;
  startsAt: Date;
  endsAt: Date;
  openingPriceMinor: number;
  incrementMinor: number;
  relistedFromId: string | null;
}

/** Inserts the auction row and moves the listing into the auction's public lifecycle (one transaction). */
async function insertAuction(tx: Queryable, ctx: AppContext, userId: string, a: ScheduleArgs): Promise<AuctionRow> {
  const now = ctx.now();
  const liveNow = a.startsAt.getTime() <= now.getTime();
  const policy = await latestAuctionPolicy(tx, now);
  await ensureOneAvailableUnit(tx, a.listingId, userId);
  await tx.query(
    `UPDATE listings SET status = $2, published_at = coalesce(published_at, $3), price_minor = NULL, min_offer_minor = NULL, updated_at = now() WHERE id = $1`,
    [a.listingId, liveNow ? 'active' : 'scheduled', liveNow ? now : a.startsAt],
  );
  await writeVersionIfChanged(tx, a.listingId);
  const auction = await maybeOne<AuctionRow>(
    tx,
    `INSERT INTO auctions (listing_id, shop_id, status, starts_at, ends_at, original_ends_at, opening_price_minor, increment_minor,
                           extension_window_seconds, extension_seconds, max_extension_seconds, policy_version_id, relisted_from_id)
     VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (listing_id) WHERE status IN ('draft','scheduled','live','awaiting_payment') DO NOTHING
     RETURNING *`,
    [
      a.listingId,
      a.shopId,
      liveNow ? 'live' : 'scheduled',
      liveNow ? now : a.startsAt,
      a.endsAt,
      a.openingPriceMinor,
      a.incrementMinor,
      DEFAULT_AUCTION_RULES.extensionWindowSeconds,
      DEFAULT_AUCTION_RULES.extensionSeconds,
      DEFAULT_AUCTION_RULES.maxExtensionSeconds,
      policy?.id ?? null,
      a.relistedFromId,
    ],
  );
  if (!auction) throw new DomainError('CONFLICT', 'This piece already has an auction scheduled or running.');
  await addAuctionEvent(tx, { auctionId: auction.id, seq: 0, kind: a.relistedFromId ? 'relisted' : 'scheduled', at: now, data: { startsAt: auction.starts_at, endsAt: auction.ends_at, relistedFromId: a.relistedFromId } });
  if (liveNow) await addAuctionEvent(tx, { auctionId: auction.id, seq: 0, kind: 'started', at: now });
  await enqueue(tx, {
    topic: 'auction.scheduled',
    aggregateId: auction.id,
    payload: { auctionId: auction.id, shopId: a.shopId, listingId: a.listingId, startsAt: new Date(auction.starts_at).toISOString() },
    dedupeKey: `auction.scheduled:${auction.id}`,
  });
  await recordAudit(tx, ctx, {
    action: a.relistedFromId ? 'auction.relisted' : 'auction.scheduled',
    targetKind: 'auction',
    targetId: auction.id,
    data: { listingId: a.listingId, startsAt: auction.starts_at, endsAt: auction.ends_at, openingPriceMinor: a.openingPriceMinor, incrementMinor: a.incrementMinor },
  });
  return auction;
}

/**
 * Schedules an auction for a draft unique piece the caller sells. The sale mode is fixed before publication:
 * a draft may switch to auction here, but a published fixed-price listing never becomes an auction.
 */
export async function createAuction(ctx: AppContext, raw: unknown): Promise<{ auctionId: string; status: string; startsAt: string; endsAt: string }> {
  const user = requireUser(ctx);
  const input = parseInput(createAuctionInput, raw);
  return withTransaction(ctx.pool, async (tx) => {
    const l = await loadOwnListing(tx, ctx, input.listingId, { lock: true });
    if (l.status !== 'draft') throw new DomainError('INVALID_STATE', 'Only draft pieces can be scheduled for auction. Published fixed-price items stay fixed-price.');
    if (l.quantity_mode !== 'unique') throw new DomainError('VALIDATION_FAILED', 'Auctions cover one identified piece. Change the quantity to a unique item.');
    if (l.shop_status !== 'active') throw new DomainError('INVALID_STATE', 'Open your shop before scheduling auctions.');
    const now = ctx.now();
    const startsAt = input.startsAt === 'now' ? now : input.startsAt;
    validateAuctionSchedule({ startsAt, endsAt: input.endsAt, now, openingPriceMinor: input.openingPrice, incrementMinor: input.increment });
    if (l.sale_mode !== 'auction') await tx.query(`UPDATE listings SET sale_mode = 'auction' WHERE id = $1`, [l.id]);
    const { schema } = await loadSchemaFor(tx, l.schema_version_id);
    assertPublishable(await publishCandidate(tx, { ...l, sale_mode: 'auction' }, 1), schema);
    const auction = await insertAuction(tx, ctx, user.userId, {
      listingId: l.id,
      shopId: l.shop_id,
      startsAt,
      endsAt: input.endsAt,
      openingPriceMinor: input.openingPrice,
      incrementMinor: input.increment,
      relistedFromId: null,
    });
    return { auctionId: auction.id, status: auction.status, startsAt: new Date(auction.starts_at).toISOString(), endsAt: new Date(auction.ends_at).toISOString() };
  });
}

/** Seller cancels before the first bid. The unit is withdrawn so nothing can buy it, and the listing returns to draft. */
export async function cancelAuction(ctx: AppContext, raw: unknown): Promise<{ auctionId: string; status: 'cancelled' }> {
  const user = requireUser(ctx);
  const input = parseInput(cancelAuctionInput, raw);
  return withTransaction(ctx.pool, async (tx) => {
    const a = await lockAuction(tx, input.auctionId);
    if (!(await isShopMember(tx, a.shop_id, user.userId))) throw new DomainError('NOT_FOUND', 'Auction not found.');
    if (a.bid_count > 0) throw new DomainError('INVALID_STATE', 'This auction has bids, so it can’t be cancelled or changed. Contact support if something is wrong.');
    assertAuctionTransition(a.status, 'cancelled');
    const now = ctx.now();
    await tx.query(`UPDATE auctions SET status = 'cancelled', cancelled_reason = $2, updated_at = now() WHERE id = $1`, [a.id, input.reason]);
    const stock = await maybeOne<{ quantity_available: number }>(tx, 'SELECT quantity_available FROM inventory_stock WHERE listing_id = $1', [a.listing_id]);
    if (stock && stock.quantity_available > 0) {
      await withdrawStock(tx, { listingId: a.listing_id, quantity: stock.quantity_available, reason: 'auction_cancelled', actorUserId: user.userId });
    }
    await tx.query(`UPDATE listings SET status = 'draft', updated_at = now() WHERE id = $1`, [a.listing_id]);
    await addAuctionEvent(tx, { auctionId: a.id, seq: a.seq, kind: 'cancelled', at: now, data: { reason: input.reason } });
    await recordAudit(tx, ctx, { action: 'auction.cancelled', targetKind: 'auction', targetId: a.id, reason: input.reason });
    return { auctionId: a.id, status: 'cancelled' as const };
  });
}

/**
 * Schedules a new auction for the same piece after an auction ended without bids, failed unpaid (and no
 * second-chance purchase is in progress) or was cancelled. Each relist is a new auction row with its own rules.
 */
export async function relistAuction(ctx: AppContext, raw: unknown): Promise<{ auctionId: string; status: string; startsAt: string; endsAt: string }> {
  const user = requireUser(ctx);
  const input = parseInput(relistAuctionInput, raw);
  return withTransaction(ctx.pool, async (tx) => {
    const prev = await lockAuction(tx, input.auctionId);
    if (!(await isShopMember(tx, prev.shop_id, user.userId))) throw new DomainError('NOT_FOUND', 'Auction not found.');
    if (!['ended_no_bids', 'failed_unpaid', 'cancelled'].includes(prev.status)) {
      throw new DomainError('INVALID_STATE', 'Only auctions that ended without a sale can be relisted.');
    }
    const pendingSecondChance = await maybeOne(
      tx,
      `SELECT 1 AS ok FROM second_chance_offers sc LEFT JOIN reservations r ON r.id = sc.reservation_id
        WHERE sc.auction_id = $1 AND (sc.status = 'pending' OR (sc.status = 'accepted' AND r.status IN ('active','payment_pending')))`,
      [prev.id],
    );
    if (pendingSecondChance) throw new DomainError('INVALID_STATE', 'A second-chance offer for this auction is still open. Wait for it to finish before relisting.');
    const open = await maybeOne(tx, `SELECT 1 AS ok FROM auctions WHERE listing_id = $1 AND status = ANY($2::text[])`, [prev.listing_id, [...OPEN_AUCTION_STATUSES]]);
    if (open) throw new DomainError('CONFLICT', 'This piece already has an auction scheduled or running.');
    const listing = await one<{ status: string; shop_status: string }>(
      tx,
      'SELECT l.status, s.status AS shop_status FROM listings l JOIN shops s ON s.id = l.shop_id WHERE l.id = $1 FOR UPDATE OF l',
      [prev.listing_id],
    );
    if (!['draft', 'ended'].includes(listing.status)) throw new DomainError('INVALID_STATE', 'This piece is no longer available to auction.');
    if (listing.shop_status !== 'active') throw new DomainError('INVALID_STATE', 'Open your shop before scheduling auctions.');
    const now = ctx.now();
    const startsAt = input.startsAt === 'now' ? now : input.startsAt;
    validateAuctionSchedule({ startsAt, endsAt: input.endsAt, now, openingPriceMinor: input.openingPrice, incrementMinor: input.increment });
    const auction = await insertAuction(tx, ctx, user.userId, {
      listingId: prev.listing_id,
      shopId: prev.shop_id,
      startsAt,
      endsAt: input.endsAt,
      openingPriceMinor: input.openingPrice,
      incrementMinor: input.increment,
      relistedFromId: prev.id,
    });
    return { auctionId: auction.id, status: auction.status, startsAt: new Date(auction.starts_at).toISOString(), endsAt: new Date(auction.ends_at).toISOString() };
  });
}

/**
 * Staff moderation: stops the open (draft, scheduled or live) auctions of a removed listing or a suspended shop.
 * Auctions are locked before stock (lock order). Bids are never payments, so nobody is charged; bidders are told.
 * The unit is withdrawn and the listing returns to draft so it can't sell. A winner who was already allocated keeps
 * their payment window — like paid orders, existing obligations are handled by support, not erased.
 */
export async function stopOpenAuctions(
  tx: Queryable,
  args: { listingId?: string; shopId?: string; reason: string; actorUserId: string; now: Date },
): Promise<number> {
  if (!args.listingId && !args.shopId) return 0;
  const open = await many<{ id: string }>(
    tx,
    `SELECT id FROM auctions WHERE status IN ('draft','scheduled','live') AND (listing_id = $1 OR shop_id = $2) ORDER BY id`,
    [args.listingId ?? null, args.shopId ?? null],
  );
  let stopped = 0;
  for (const { id } of open) {
    const a = await lockAuction(tx, id);
    if (!['draft', 'scheduled', 'live'].includes(a.status)) continue;
    assertAuctionTransition(a.status, 'cancelled');
    await tx.query(`UPDATE auctions SET status = 'cancelled', cancelled_reason = $2, updated_at = now() WHERE id = $1`, [a.id, `moderation: ${args.reason}`]);
    const stock = await maybeOne<{ quantity_available: number }>(tx, 'SELECT quantity_available FROM inventory_stock WHERE listing_id = $1', [a.listing_id]);
    if (stock && stock.quantity_available > 0) {
      await withdrawStock(tx, { listingId: a.listing_id, quantity: stock.quantity_available, reason: 'auction_stopped_by_moderation', actorUserId: args.actorUserId });
    }
    await tx.query(`UPDATE listings SET status = 'draft', updated_at = now() WHERE id = $1 AND status <> 'removed'`, [a.listing_id]);
    await addAuctionEvent(tx, { auctionId: a.id, seq: a.seq, kind: 'cancelled', at: args.now, data: { reason: 'moderation' } });
    const title = await listingTitle(tx, a.listing_id);
    const bidders = await many<{ bidder_user_id: string }>(tx, 'SELECT DISTINCT bidder_user_id FROM bids WHERE auction_id = $1', [a.id]);
    for (const b of bidders) {
      await notifyUser(tx, {
        userId: b.bidder_user_id,
        topic: 'transactional',
        kind: 'auction_cancelled',
        title: `The auction for “${title}” was cancelled`,
        body: 'Our trust & safety team stopped this auction. You haven’t been charged — bids are never payments.',
        link: auctionLinks.auction(a.id),
        dedupeKey: `auction-cancelled:${a.id}:${b.bidder_user_id}`,
      });
    }
    stopped++;
  }
  return stopped;
}
