import { placeBidInput } from '@thrift/contracts';
import { DomainError, evaluateBid, formatNaira } from '@thrift/domain';
import { maybeOne, one, withTransaction } from '@thrift/database';
import { requireVerifiedUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { enforceRateLimit } from '../core/rate-limit';
import { quoteDeliveryOptions } from '../delivery/quote';
import { notifyUser } from '../notifications/notify';
import { addAuctionEvent, auctionLinks, isShopMember, isUuid, listingTitle, lockAuction, readAuction, shopOwnerId, toAuctionState, type DeliveryQuoteSnapshot } from './shared';

export interface BidResult {
  bidId: string;
  auctionId: string;
  amountMinor: number;
  seq: number;
  endsAt: string;
  extended: boolean;
  /** True when this response replays an earlier submission with the same idempotency key. */
  replayed: boolean;
}

/**
 * Places a bid. Eligibility (verified contact, not the seller's shop, a deliverable address) is checked first;
 * then ONE short transaction locks the auction row, reads server time after the lock, validates the bid with the
 * domain rules (minimum next bid, anti-sniping extension) and records it. Bids and the finaliser serialise on the
 * same row, so a bid is never accepted after the auction is finalised.
 */
export async function placeBid(ctx: AppContext, raw: unknown): Promise<BidResult> {
  const user = requireVerifiedUser(ctx);
  const input = parseBid(raw);
  const replay = async () =>
    maybeOne<{ id: string; amount_minor: number; seq: number }>(
      ctx.pool,
      'SELECT id, amount_minor, seq FROM bids WHERE auction_id = $1 AND bidder_user_id = $2 AND idempotency_key = $3',
      [input.auctionId, user.userId, input.idempotencyKey],
    );
  const prior = await replay();
  if (prior) return replayResult(ctx, input.auctionId, prior);

  await enforceRateLimit(ctx.pool, `bid.minute:${user.userId}`, 30, 60, 'You’re bidding too quickly. Wait a moment and try again.');
  await enforceRateLimit(ctx.pool, `bid.hour:${user.userId}`, 600, 3600, 'You’ve reached the hourly bidding limit. Try again later.');

  const pre = await readAuction(ctx.pool, input.auctionId);
  if (!pre || pre.status === 'draft') throw new DomainError('NOT_FOUND', 'Auction not found.');
  if (await isShopMember(ctx.pool, pre.shop_id, user.userId)) throw new DomainError('FORBIDDEN', 'Sellers and their shop staff can’t bid on their own auctions.');
  const account = await one<{ status: string }>(ctx.pool, 'SELECT status FROM users WHERE id = $1', [user.userId]);
  if (account.status !== 'active') throw new DomainError('FORBIDDEN', 'Your account can’t bid right now. Contact support.');
  const quote = await deliveryQuoteFor(ctx, user.userId, pre.listing_id, input.addressId);

  try {
    return await withTransaction(ctx.pool, async (tx) => {
      const a = await lockAuction(tx, input.auctionId);
      const now = ctx.now(); // read AFTER acquiring the lock
      const sellerUserId = await shopOwnerId(tx, a.shop_id);
      const decision = evaluateBid(toAuctionState(a, sellerUserId), { bidderId: user.userId, amountMinor: input.amount }, now);
      const seq = a.seq + 1;
      const bid = await one<{ id: string; created_at: Date }>(
        tx,
        `INSERT INTO bids (auction_id, bidder_user_id, amount_minor, seq, idempotency_key, destination_state, delivery_quote, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_at`,
        [a.id, user.userId, input.amount, seq, input.idempotencyKey, quote.state, JSON.stringify(quote), now],
      );
      await tx.query(
        `UPDATE auctions SET current_bid_minor = $2, current_bid_id = $3, current_bidder_user_id = $4, bid_count = bid_count + 1, seq = $5,
                ends_at = $6, status = CASE WHEN status = 'scheduled' THEN 'live' ELSE status END, updated_at = now()
          WHERE id = $1`,
        [a.id, input.amount, bid.id, user.userId, seq, decision.newEndsAt],
      );
      if (a.status === 'scheduled') {
        await tx.query(`UPDATE listings SET status = 'active', updated_at = now() WHERE id = $1 AND status = 'scheduled'`, [a.listing_id]);
        await addAuctionEvent(tx, { auctionId: a.id, seq: a.seq, kind: 'started', at: now });
      }
      await addAuctionEvent(tx, { auctionId: a.id, seq, kind: 'bid', at: now, data: { bidId: bid.id, amountMinor: input.amount } });
      if (decision.extended) {
        await addAuctionEvent(tx, { auctionId: a.id, seq, kind: 'extended', at: now, data: { from: new Date(a.ends_at).toISOString(), to: decision.newEndsAt.toISOString() } });
      }
      const title = await listingTitle(tx, a.listing_id);
      if (a.current_bidder_user_id && a.current_bidder_user_id !== user.userId) {
        await notifyUser(tx, {
          userId: a.current_bidder_user_id,
          topic: 'auctions',
          kind: 'outbid',
          title: `You’ve been outbid on “${title}”`,
          body: `The current bid is ${formatNaira(input.amount)}. The minimum next bid is ${formatNaira(input.amount + a.increment_minor)}.`,
          link: auctionLinks.auction(a.id),
          dedupeKey: `outbid:${bid.id}`,
        });
      }
      if (a.bid_count === 0) {
        await notifyUser(tx, {
          userId: sellerUserId,
          topic: 'transactional',
          kind: 'auction_first_bid',
          title: `First bid on “${title}”: ${formatNaira(input.amount)}`,
          body: 'The auction terms are now locked.',
          link: auctionLinks.auction(a.id),
          dedupeKey: `auction-first-bid:${a.id}`,
        });
      }
      return { bidId: bid.id, auctionId: a.id, amountMinor: input.amount, seq, endsAt: decision.newEndsAt.toISOString(), extended: decision.extended, replayed: false };
    });
  } catch (err) {
    // A concurrent retry with the same key won the unique index: return that bid instead of an error.
    if ((err as { code?: string }).code === '23505') {
      const again = await replay();
      if (again) return replayResult(ctx, input.auctionId, again);
    }
    throw err;
  }
}

function parseBid(raw: unknown) {
  const r = placeBidInput.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    const field = String(issue?.path[0] ?? 'amount');
    throw new DomainError('VALIDATION_FAILED', issue?.message ?? 'Check your bid.', { fieldErrors: { [field]: issue?.message ?? 'Check this field.' } });
  }
  return r.data;
}

async function replayResult(ctx: AppContext, auctionId: string, b: { id: string; amount_minor: number; seq: number }): Promise<BidResult> {
  const a = await readAuction(ctx.pool, auctionId);
  return { bidId: b.id, auctionId, amountMinor: b.amount_minor, seq: b.seq, endsAt: new Date(a!.ends_at).toISOString(), extended: false, replayed: true };
}

/** The bidder's destination must be deliverable for this piece; the quote is recorded with the bid. */
async function deliveryQuoteFor(ctx: AppContext, userId: string, listingId: string, addressId: string | undefined): Promise<DeliveryQuoteSnapshot> {
  const addr = await maybeOne<{ id: string; state: string; city: string }>(
    ctx.pool,
    addressId && isUuid(addressId)
      ? 'SELECT id, state, city FROM addresses WHERE id = $2 AND user_id = $1 AND archived_at IS NULL'
      : 'SELECT id, state, city FROM addresses WHERE user_id = $1 AND archived_at IS NULL ORDER BY is_default DESC, created_at DESC LIMIT 1',
    addressId && isUuid(addressId) ? [userId, addressId] : [userId],
  );
  if (!addr) {
    throw new DomainError('NOT_DELIVERABLE', 'Add a delivery address before bidding, so we can confirm this seller delivers to you.', { action: 'add_address', link: auctionLinks.addresses });
  }
  const options = await quoteDeliveryOptions(ctx.pool, { listingId, destination: { state: addr.state, city: addr.city } });
  if (options.length === 0) {
    throw new DomainError('NOT_DELIVERABLE', `This seller doesn’t deliver to ${addr.city}, ${addr.state}. Add or choose a delivery address they cover before bidding.`, {
      action: 'add_address',
      link: auctionLinks.addresses,
    });
  }
  return {
    addressId: addr.id,
    state: addr.state,
    city: addr.city,
    quotedAt: ctx.now().toISOString(),
    options: options.map((o) => ({ method: o.method, label: o.label, feeMinor: o.feeMinor, transitDaysMin: o.transitDaysMin, transitDaysMax: o.transitDaysMax, dispatchDays: o.dispatchDays })),
  };
}
