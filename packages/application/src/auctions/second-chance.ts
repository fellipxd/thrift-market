import { auctionIdInput, secondChanceOfferIdInput } from '@thrift/contracts';
import { DomainError, formatNaira, formatWat } from '@thrift/domain';
import { many, maybeOne, one, withTransaction } from '@thrift/database';
import { recordAudit } from '../core/audit';
import { requireUser, requireVerifiedUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { getSettings } from '../core/settings';
import { parseInput } from '../core/validation';
import { reserveStock } from '../inventory/authority';
import { notifyUser } from '../notifications/notify';
import { addAuctionEvent, auctionLinks, isShopMember, listingTitle, lockAuction, shopOwnerId } from './shared';

interface SecondChanceRow {
  id: string;
  auction_id: string;
  bidder_user_id: string;
  amount_minor: number;
  status: 'pending' | 'accepted' | 'declined' | 'expired';
  expires_at: Date;
  reservation_id: string | null;
  [k: string]: unknown;
}

/**
 * After a winner fails to pay, the seller may offer the piece to the highest bidder other than the failed winner,
 * at that bidder's own highest bid. Nothing is reserved or charged until the runner-up explicitly accepts.
 */
export async function offerSecondChance(ctx: AppContext, raw: unknown): Promise<{ offerId: string; amountMinor: number; expiresAt: string }> {
  const user = requireUser(ctx);
  const input = parseInput(auctionIdInput, raw);
  const settings = await getSettings(ctx.pool);
  return withTransaction(ctx.pool, async (tx) => {
    const a = await lockAuction(tx, input.auctionId);
    if (!(await isShopMember(tx, a.shop_id, user.userId))) throw new DomainError('NOT_FOUND', 'Auction not found.');
    if (a.status !== 'failed_unpaid') throw new DomainError('INVALID_STATE', 'A second chance can only be offered after the winner missed the payment deadline.');
    const open = await maybeOne(tx, `SELECT 1 AS ok FROM second_chance_offers WHERE auction_id = $1 AND status = 'pending'`, [a.id]);
    if (open) throw new DomainError('INVALID_STATE', 'A second-chance offer is already waiting for a reply.');
    const listing = await one<{ status: string }>(tx, 'SELECT status FROM listings WHERE id = $1', [a.listing_id]);
    if (listing.status !== 'draft') throw new DomainError('INVALID_STATE', 'This piece is no longer available for a second-chance offer.');
    // Highest bid per bidder, excluding the failed winner and anyone already offered a second chance.
    const target = await maybeOne<{ bidder_user_id: string; amount_minor: number }>(
      tx,
      `SELECT b.bidder_user_id, max(b.amount_minor)::bigint AS amount_minor
         FROM bids b
        WHERE b.auction_id = $1 AND b.bidder_user_id <> $2
          AND NOT EXISTS (SELECT 1 FROM second_chance_offers sc WHERE sc.auction_id = b.auction_id AND sc.bidder_user_id = b.bidder_user_id)
        GROUP BY b.bidder_user_id
        ORDER BY amount_minor DESC, min(b.seq)
        LIMIT 1`,
      [a.id, a.winner_user_id],
    );
    if (!target) throw new DomainError('INVALID_STATE', 'There’s no other bidder to offer a second chance to. You can relist the piece instead.');
    const expiresAt = new Date(ctx.now().getTime() + settings.second_chance_hours * 3_600_000);
    const offer = await one<{ id: string }>(
      tx,
      `INSERT INTO second_chance_offers (auction_id, bidder_user_id, amount_minor, expires_at) VALUES ($1, $2, $3, $4) RETURNING id`,
      [a.id, target.bidder_user_id, target.amount_minor, expiresAt],
    );
    await addAuctionEvent(tx, { auctionId: a.id, seq: a.seq, kind: 'second_chance_offered', at: ctx.now(), data: { offerId: offer.id, amountMinor: target.amount_minor } });
    const title = await listingTitle(tx, a.listing_id);
    await notifyUser(tx, {
      userId: target.bidder_user_id,
      topic: 'transactional',
      kind: 'second_chance_offered',
      title: `Second chance: buy “${title}” for ${formatNaira(target.amount_minor)}`,
      body: `The winner didn’t pay. You can buy it at your highest bid — nothing is charged unless you accept. Reply by ${formatWat(expiresAt)}.`,
      link: auctionLinks.auction(a.id),
      dedupeKey: `second-chance:${offer.id}`,
    });
    await recordAudit(tx, ctx, { action: 'auction.second_chance_offered', targetKind: 'auction', targetId: a.id, data: { offerId: offer.id, amountMinor: target.amount_minor } });
    return { offerId: offer.id, amountMinor: target.amount_minor, expiresAt: expiresAt.toISOString() };
  });
}

/** The runner-up accepts: the piece is reserved at their bid for the payment window, then they pay at checkout. */
export async function acceptSecondChance(ctx: AppContext, raw: unknown): Promise<{ offerId: string; reservationId: string; checkoutPath: string }> {
  const user = requireVerifiedUser(ctx);
  const input = parseInput(secondChanceOfferIdInput, raw);
  const settings = await getSettings(ctx.pool);
  const peek = await maybeOne<{ auction_id: string }>(ctx.pool, 'SELECT auction_id FROM second_chance_offers WHERE id = $1 AND bidder_user_id = $2', [input.offerId, user.userId]);
  if (!peek) throw new DomainError('NOT_FOUND', 'Offer not found.');
  return withTransaction(ctx.pool, async (tx) => {
    const a = await lockAuction(tx, peek.auction_id); // auction → second-chance offer → stock (lock order)
    const sc = await one<SecondChanceRow>(tx, 'SELECT * FROM second_chance_offers WHERE id = $1 FOR UPDATE', [input.offerId]);
    if (sc.status === 'accepted' && sc.reservation_id) return { offerId: sc.id, reservationId: sc.reservation_id, checkoutPath: auctionLinks.checkoutSecondChance(sc.id) };
    if (sc.status !== 'pending') throw new DomainError('INVALID_STATE', 'This offer is no longer open.');
    if (new Date(sc.expires_at) <= ctx.now()) throw new DomainError('EXPIRED', 'This offer has expired.');
    if (a.status !== 'failed_unpaid') throw new DomainError('INVALID_STATE', 'This piece is no longer available.');
    const reservation = await reserveStock(tx, {
      listingId: a.listing_id,
      buyerUserId: user.userId,
      quantity: 1,
      source: 'second_chance',
      sourceId: sc.id,
      unitPriceMinor: sc.amount_minor,
      expiresAt: new Date(ctx.now().getTime() + settings.winner_payment_hours * 3_600_000),
      actorUserId: user.userId,
    });
    await tx.query(`UPDATE second_chance_offers SET status = 'accepted', reservation_id = $2, responded_at = now() WHERE id = $1`, [sc.id, reservation.id]);
    await addAuctionEvent(tx, { auctionId: a.id, seq: a.seq, kind: 'second_chance_accepted', at: ctx.now(), data: { offerId: sc.id, reservationId: reservation.id } });
    const title = await listingTitle(tx, a.listing_id);
    await notifyUser(tx, {
      userId: await shopOwnerId(tx, a.shop_id),
      topic: 'transactional',
      kind: 'second_chance_accepted',
      title: `Second-chance offer accepted for “${title}”`,
      body: 'The buyer is paying now. Don’t send the item until the order shows as paid.',
      link: auctionLinks.sellAuctions,
      dedupeKey: `second-chance-accepted:${sc.id}`,
    });
    return { offerId: sc.id, reservationId: reservation.id, checkoutPath: auctionLinks.checkoutSecondChance(sc.id) };
  });
}

export async function declineSecondChance(ctx: AppContext, raw: unknown): Promise<{ offerId: string; status: 'declined' }> {
  const user = requireUser(ctx);
  const input = parseInput(secondChanceOfferIdInput, raw);
  const peek = await maybeOne<{ auction_id: string }>(ctx.pool, 'SELECT auction_id FROM second_chance_offers WHERE id = $1 AND bidder_user_id = $2', [input.offerId, user.userId]);
  if (!peek) throw new DomainError('NOT_FOUND', 'Offer not found.');
  return withTransaction(ctx.pool, async (tx) => {
    const a = await lockAuction(tx, peek.auction_id);
    const sc = await one<SecondChanceRow>(tx, 'SELECT * FROM second_chance_offers WHERE id = $1 FOR UPDATE', [input.offerId]);
    if (sc.status !== 'pending') throw new DomainError('INVALID_STATE', 'This offer is no longer open.');
    await tx.query(`UPDATE second_chance_offers SET status = 'declined', responded_at = now() WHERE id = $1`, [sc.id]);
    await addAuctionEvent(tx, { auctionId: a.id, seq: a.seq, kind: 'second_chance_declined', at: ctx.now(), data: { offerId: sc.id } });
    await notifyUser(tx, {
      userId: await shopOwnerId(tx, a.shop_id),
      topic: 'transactional',
      kind: 'second_chance_declined',
      title: 'Second-chance offer declined',
      body: 'You can offer it to the next bidder or relist the piece.',
      link: auctionLinks.sellAuctions,
      dedupeKey: `second-chance-declined:${sc.id}`,
    });
    return { offerId: sc.id, status: 'declined' as const };
  });
}

/** Worker: pending second-chance offers past their expiry lapse (nothing was reserved or charged). */
export async function expireSecondChances(ctx: AppContext, batchSize = 50): Promise<{ expired: number }> {
  const due = await many<{ id: string; auction_id: string }>(
    ctx.pool,
    `SELECT id, auction_id FROM second_chance_offers WHERE status = 'pending' AND expires_at <= $1 ORDER BY expires_at LIMIT $2`,
    [ctx.now(), batchSize],
  );
  let expired = 0;
  for (const d of due) {
    const ok = await withTransaction(ctx.pool, async (tx) => {
      const a = await maybeOne<{ id: string; seq: number; shop_id: string }>(tx, 'SELECT id, seq, shop_id FROM auctions WHERE id = $1 FOR UPDATE SKIP LOCKED', [d.auction_id]);
      if (!a) return false;
      const row = await maybeOne<{ id: string }>(
        tx,
        `UPDATE second_chance_offers SET status = 'expired', responded_at = now() WHERE id = $1 AND status = 'pending' AND expires_at <= $2 RETURNING id`,
        [d.id, ctx.now()],
      );
      if (!row) return false;
      await addAuctionEvent(tx, { auctionId: a.id, seq: a.seq, kind: 'second_chance_expired', at: ctx.now(), data: { offerId: d.id } });
      await notifyUser(tx, {
        userId: await shopOwnerId(tx, a.shop_id),
        topic: 'transactional',
        kind: 'second_chance_expired',
        title: 'Second-chance offer expired',
        body: 'The runner-up didn’t reply in time. You can offer it to the next bidder or relist the piece.',
        link: auctionLinks.sellAuctions,
        dedupeKey: `second-chance-expired:${d.id}`,
      });
      return true;
    });
    if (ok) expired++;
  }
  return { expired };
}
