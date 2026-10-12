import { formatNaira, formatWat } from '@thrift/domain';
import { many, maybeOne, one, withTransaction, type Queryable } from '@thrift/database';
import type { AppContext } from '../core/context';
import { getSettings } from '../core/settings';
import { reserveStock, withdrawStock } from '../inventory/authority';
import { notifyUser } from '../notifications/notify';
import { addAuctionEvent, assertAuctionTransition, auctionLinks, listingTitle, lockAuction, shopOwnerId, type DeliveryQuoteSnapshot } from './shared';

/** Worker: scheduled auctions whose start time has passed go live (bids are accepted from starts_at regardless). */
export async function startDueAuctions(ctx: AppContext, batchSize = 50): Promise<{ started: number }> {
  const due = await many<{ id: string }>(
    ctx.pool,
    `SELECT id FROM auctions WHERE status = 'scheduled' AND starts_at <= $1 ORDER BY starts_at LIMIT $2`,
    [ctx.now(), batchSize],
  );
  let started = 0;
  for (const d of due) {
    const ok = await withTransaction(ctx.pool, async (tx) => {
      const a = await maybeOne<{ id: string; listing_id: string; seq: number; status: string; starts_at: Date }>(
        tx,
        'SELECT id, listing_id, seq, status, starts_at FROM auctions WHERE id = $1 FOR UPDATE SKIP LOCKED',
        [d.id],
      );
      if (!a || a.status !== 'scheduled' || new Date(a.starts_at) > ctx.now()) return false;
      await tx.query(`UPDATE auctions SET status = 'live', updated_at = now() WHERE id = $1`, [a.id]);
      await tx.query(`UPDATE listings SET status = 'active', updated_at = now() WHERE id = $1 AND status = 'scheduled'`, [a.listing_id]);
      await addAuctionEvent(tx, { auctionId: a.id, seq: a.seq, kind: 'started', at: ctx.now() });
      return true;
    });
    if (ok) started++;
  }
  return { started };
}

export type FinalizeOutcome = 'not_due' | 'already_final' | 'ended_no_bids' | 'winner_allocated' | 'skipped';

/** Test hook: lets tests simulate a crash after the winner's reservation is written (the transaction then rolls back). */
export const finalizeHooks: { afterReserve?: (auctionId: string) => void | Promise<void> } = {};

/**
 * Finalises one auction in a single transaction. Re-reads the row under lock and re-checks the end time with server
 * time read after the lock (a late bid may have extended it). Idempotent: the status guard and the reservations
 * source uniqueness mean concurrent or repeated finalisers produce exactly one winner and one reservation.
 */
export async function finalizeAuction(ctx: AppContext, auctionId: string, opts: { skipLocked?: boolean } = {}): Promise<FinalizeOutcome> {
  const settings = await getSettings(ctx.pool);
  return withTransaction(ctx.pool, async (tx) => {
    let a;
    if (opts.skipLocked) {
      const locked = await maybeOne<{ id: string }>(tx, 'SELECT id FROM auctions WHERE id = $1 FOR UPDATE SKIP LOCKED', [auctionId]);
      if (!locked) return 'skipped' as const;
    }
    a = await lockAuction(tx, auctionId);
    if (a.status !== 'live' && a.status !== 'scheduled') return 'already_final' as const;
    const now = ctx.now();
    if (new Date(a.ends_at).getTime() > now.getTime()) return 'not_due' as const;
    const title = await listingTitle(tx, a.listing_id);
    const sellerUserId = await shopOwnerId(tx, a.shop_id);

    if (a.bid_count === 0 || !a.current_bidder_user_id || a.current_bid_minor === null) {
      // A scheduled auction that was never started moves through 'live' implicitly.
      assertAuctionTransition('live', 'ended_no_bids');
      await tx.query(`UPDATE auctions SET status = 'ended_no_bids', finalized_at = $2, updated_at = now() WHERE id = $1`, [a.id, now]);
      const stock = await maybeOne<{ quantity_available: number }>(tx, 'SELECT quantity_available FROM inventory_stock WHERE listing_id = $1', [a.listing_id]);
      if (stock && stock.quantity_available > 0) {
        await withdrawStock(tx, { listingId: a.listing_id, quantity: stock.quantity_available, reason: 'auction_ended_no_bids', actorUserId: sellerUserId });
      }
      await tx.query(`UPDATE listings SET status = 'ended', updated_at = now() WHERE id = $1`, [a.listing_id]);
      await addAuctionEvent(tx, { auctionId: a.id, seq: a.seq, kind: 'ended', at: now, data: { outcome: 'no_bids' } });
      await notifyUser(tx, {
        userId: sellerUserId,
        topic: 'transactional',
        kind: 'auction_ended_no_bids',
        title: `Your auction for “${title}” ended without bids`,
        body: 'You can relist it with a new start time or opening price.',
        link: auctionLinks.sellAuctions,
        dedupeKey: `auction-ended:${a.id}`,
      });
      return 'ended_no_bids' as const;
    }

    assertAuctionTransition('live', 'awaiting_payment');
    const deadline = new Date(now.getTime() + settings.winner_payment_hours * 3_600_000);
    const reservation = await reserveStock(tx, {
      listingId: a.listing_id,
      buyerUserId: a.current_bidder_user_id,
      quantity: 1,
      source: 'auction',
      sourceId: a.id,
      unitPriceMinor: a.current_bid_minor,
      expiresAt: deadline,
    });
    await finalizeHooks.afterReserve?.(a.id);
    const winningBid = await maybeOne<{ delivery_quote: DeliveryQuoteSnapshot | null }>(tx, 'SELECT delivery_quote FROM bids WHERE id = $1', [a.current_bid_id]);
    await tx.query(
      `UPDATE auctions SET status = 'awaiting_payment', winner_user_id = $2, winning_bid_id = $3, payment_deadline_at = $4, reservation_id = $5,
              winner_delivery_quote = $6, finalized_at = $7, updated_at = now()
        WHERE id = $1`,
      [a.id, a.current_bidder_user_id, a.current_bid_id, deadline, reservation.id, winningBid?.delivery_quote ? JSON.stringify(winningBid.delivery_quote) : null, now],
    );
    await addAuctionEvent(tx, { auctionId: a.id, seq: a.seq, kind: 'ended', at: now, data: { outcome: 'sold', amountMinor: a.current_bid_minor } });
    await addAuctionEvent(tx, { auctionId: a.id, seq: a.seq, kind: 'winner_allocated', at: now, data: { bidId: a.current_bid_id, reservationId: reservation.id, deadline: deadline.toISOString() } });
    await notifyUser(tx, {
      userId: a.current_bidder_user_id,
      topic: 'transactional',
      kind: 'auction_won',
      title: `You won “${title}” for ${formatNaira(a.current_bid_minor)}`,
      body: `Pay by ${formatWat(deadline)} to complete your purchase. Delivery is added at checkout.`,
      link: auctionLinks.checkoutAuction(a.id),
      dedupeKey: `auction-won:${a.id}`,
    });
    await notifyUser(tx, {
      userId: sellerUserId,
      topic: 'transactional',
      kind: 'auction_sold',
      title: `“${title}” sold at auction for ${formatNaira(a.current_bid_minor)}`,
      body: `The winner has until ${formatWat(deadline)} to pay. Don’t send the item until the order shows as paid.`,
      link: auctionLinks.sellAuctions,
      dedupeKey: `auction-sold:${a.id}`,
    });
    const others = await many<{ bidder_user_id: string }>(
      tx,
      'SELECT DISTINCT bidder_user_id FROM bids WHERE auction_id = $1 AND bidder_user_id <> $2',
      [a.id, a.current_bidder_user_id],
    );
    for (const o of others) {
      await notifyUser(tx, {
        userId: o.bidder_user_id,
        topic: 'auctions',
        kind: 'auction_lost',
        title: `The auction for “${title}” has ended`,
        body: `It closed at ${formatNaira(a.current_bid_minor)}. You haven’t been charged — bids are never payments.`,
        link: auctionLinks.auction(a.id),
        dedupeKey: `auction-lost:${a.id}:${o.bidder_user_id}`,
      });
    }
    return 'winner_allocated' as const;
  });
}

/** Worker watchdog: finalises every live (or never-started scheduled) auction whose end time has passed. */
export async function finalizeDueAuctions(ctx: AppContext, batchSize = 50): Promise<{ finalized: number }> {
  const due = await many<{ id: string }>(
    ctx.pool,
    `SELECT id FROM auctions WHERE status IN ('live','scheduled') AND ends_at <= $1 ORDER BY ends_at LIMIT $2`,
    [ctx.now(), batchSize],
  );
  let finalized = 0;
  for (const d of due) {
    const r = await finalizeAuction(ctx, d.id, { skipLocked: true });
    if (r === 'ended_no_bids' || r === 'winner_allocated') finalized++;
  }
  return { finalized };
}

/**
 * Outbox: a reservation was released. For an auction winner this happens only after checkout confirmed no payment
 * can still succeed — the auction fails unpaid, the winner gets a strike, and the listing returns to draft so the
 * seller can relist or offer a second chance. A lapsed second-chance hold just returns the listing to draft.
 */
export async function onAuctionReservationReleased(tx: Queryable, payload: { reservationId?: string; source?: string; sourceId?: string | null }): Promise<void> {
  if (!payload.sourceId || !payload.reservationId) return;
  if (payload.source === 'second_chance') {
    const sc = await maybeOne<{ auction_id: string; reservation_id: string | null }>(tx, 'SELECT auction_id, reservation_id FROM second_chance_offers WHERE id = $1', [payload.sourceId]);
    if (!sc || sc.reservation_id !== payload.reservationId) return;
    const a = await lockAuction(tx, sc.auction_id);
    if (a.status !== 'failed_unpaid') return;
    await tx.query(`UPDATE listings SET status = 'draft', updated_at = now() WHERE id = $1 AND status IN ('active','reserved')`, [a.listing_id]);
    return;
  }
  if (payload.source !== 'auction') return;
  const a = await lockAuction(tx, payload.sourceId);
  if (a.status !== 'awaiting_payment' || a.reservation_id !== payload.reservationId || !a.winner_user_id) return;
  assertAuctionTransition('awaiting_payment', 'failed_unpaid');
  const now = new Date();
  await tx.query(`UPDATE auctions SET status = 'failed_unpaid', updated_at = now() WHERE id = $1`, [a.id]);
  await tx.query(`UPDATE users SET auction_strikes = auction_strikes + 1 WHERE id = $1`, [a.winner_user_id]);
  await tx.query(`UPDATE listings SET status = 'draft', updated_at = now() WHERE id = $1 AND status IN ('active','reserved')`, [a.listing_id]);
  await addAuctionEvent(tx, { auctionId: a.id, seq: a.seq, kind: 'failed_unpaid', at: now, data: { winnerStrike: true } });
  const title = await listingTitle(tx, a.listing_id);
  const sellerUserId = await shopOwnerId(tx, a.shop_id);
  const runnerUp = await maybeOne(tx, 'SELECT 1 AS ok FROM bids WHERE auction_id = $1 AND bidder_user_id <> $2 LIMIT 1', [a.id, a.winner_user_id]);
  await notifyUser(tx, {
    userId: sellerUserId,
    topic: 'transactional',
    kind: 'auction_failed_unpaid',
    title: `The winner didn’t pay for “${title}”`,
    body: runnerUp
      ? 'You can offer the runner-up a second chance at their own highest bid, or relist the piece.'
      : 'You can relist the piece with a new auction.',
    link: auctionLinks.sellAuctions,
    dedupeKey: `auction-failed:${a.id}`,
  });
  await notifyUser(tx, {
    userId: a.winner_user_id,
    topic: 'transactional',
    kind: 'auction_payment_missed',
    title: `Payment deadline missed for “${title}”`,
    body: 'The piece has been released. Missed auction payments are recorded on your account and can limit future bidding.',
    link: auctionLinks.auction(a.id),
    dedupeKey: `auction-missed:${a.id}`,
  });
}

/** Outbox: an auction or second-chance order was paid → the auction is complete. Idempotent. */
export async function onAuctionOrderPaid(tx: Queryable, payload: { orderId?: string }): Promise<void> {
  if (!payload.orderId) return;
  const o = await maybeOne<{ id: string; source: string; source_id: string | null }>(tx, 'SELECT id, source, source_id FROM orders WHERE id = $1', [payload.orderId]);
  if (!o?.source_id) return;
  let auctionId: string | null = null;
  if (o.source === 'auction') auctionId = o.source_id;
  else if (o.source === 'second_chance') {
    auctionId = (await maybeOne<{ auction_id: string }>(tx, 'SELECT auction_id FROM second_chance_offers WHERE id = $1', [o.source_id]))?.auction_id ?? null;
  }
  if (!auctionId) return;
  const a = await lockAuction(tx, auctionId);
  if (a.status !== 'awaiting_payment' && a.status !== 'failed_unpaid') return;
  assertAuctionTransition(a.status, 'paid');
  await tx.query(`UPDATE auctions SET status = 'paid', updated_at = now() WHERE id = $1`, [a.id]);
  await addAuctionEvent(tx, { auctionId: a.id, seq: a.seq, kind: 'payment_received', at: new Date(), data: { orderId: o.id, source: o.source } });
}

export async function strikeCount(db: Queryable, userId: string): Promise<number> {
  return (await one<{ n: number }>(db, 'SELECT auction_strikes AS n FROM users WHERE id = $1', [userId])).n;
}
