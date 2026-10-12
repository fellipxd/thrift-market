import { makeOfferInput, respondToOfferInput } from '@thrift/contracts';
import {
  assertOfferAction,
  DomainError,
  evaluateOfferAmount,
  formatNaira,
  isDomainError,
  type OfferParty,
  type OfferStatus,
  type OfferThreadStatus,
} from '@thrift/domain';
import { maybeOne, one, withTransaction, type Queryable } from '@thrift/database';
import { recordAudit } from '../core/audit';
import { requireVerifiedUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { withIdempotency } from '../core/idempotency';
import { enforceRateLimit } from '../core/rate-limit';
import { getSettings } from '../core/settings';
import { parseInput } from '../core/validation';
import { reserveStock } from '../inventory/authority';
import { notifyUser } from '../notifications/notify';
import { assertNotBlocked, bumpListingStat, shopMemberIds } from '../messaging/access';
import { ensureListingConversation, insertMessage, postSystemMessage } from '../messaging/messages';

export type OfferOutcome = 'pending' | 'auto_declined' | 'accepted' | 'rejected' | 'withdrawn' | 'countered' | 'unavailable';

export interface OfferResult {
  status: OfferOutcome;
  threadId: string;
  conversationId: string | null;
  offerId: string;
  message: string;
  /** Buyer checkout link after acceptance. */
  checkoutPath: string | null;
}

export const BELOW_MINIMUM_MESSAGE = 'This offer is below what the seller will accept. Try a higher amount.';
export const UNAVAILABLE_MESSAGE = 'This piece was just reserved or sold by someone else, so the offer can’t be completed.';

interface ListingForOffer {
  id: string;
  shop_id: string;
  title: string;
  status: string;
  sale_mode: string;
  price_minor: number | null;
  min_offer_minor: number | null;
  shop_status: string;
  available: number | null;
  [k: string]: unknown;
}

interface ThreadLock {
  id: string;
  listing_id: string;
  shop_id: string;
  buyer_user_id: string;
  conversation_id: string | null;
  status: OfferThreadStatus;
  [k: string]: unknown;
}

interface OfferLock {
  id: string;
  thread_id: string;
  seq: number;
  from_party: OfferParty;
  amount_minor: number;
  status: OfferStatus;
  expires_at: Date;
  [k: string]: unknown;
}

const loadListing = (db: Queryable, listingId: string) =>
  maybeOne<ListingForOffer>(
    db,
    `SELECT l.id, l.shop_id, l.title, l.status, l.sale_mode, l.price_minor, l.min_offer_minor, s.status AS shop_status, st.quantity_available AS available
       FROM listings l JOIN shops s ON s.id = l.shop_id LEFT JOIN inventory_stock st ON st.listing_id = l.id WHERE l.id = $1`,
    [listingId],
  );

/** Offer card text. Amounts are item price only; delivery and fees are added at checkout. */
function offerCardBody(party: OfferParty, amountMinor: number, note: string | null): string {
  const who = party === 'buyer' ? 'Buyer offered' : 'Seller offered';
  return `${who} ${formatNaira(amountMinor)}${note ? ` — “${note}”` : ''}`;
}

async function buyerOffersToday(db: Queryable, threadId: string): Promise<number> {
  const r = await one<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM offers WHERE thread_id = $1 AND from_party = 'buyer' AND created_at > now() - interval '24 hours'`,
    [threadId],
  );
  return r.n;
}

async function notifyParty(
  db: Queryable,
  thread: { shop_id: string; buyer_user_id: string; conversation_id: string | null },
  to: OfferParty,
  args: { kind: string; title: string; body?: string; link?: string; dedupeKey: string; exceptUserId?: string },
): Promise<void> {
  const recipients = to === 'buyer' ? [thread.buyer_user_id] : await shopMemberIds(db, thread.shop_id);
  for (const userId of recipients.filter((id) => id !== args.exceptUserId)) {
    await notifyUser(db, {
      userId,
      topic: 'transactional',
      kind: args.kind,
      title: args.title,
      body: args.body,
      link: args.link ?? (thread.conversation_id ? `/inbox/${thread.conversation_id}` : null),
      dedupeKey: args.dedupeKey,
    });
  }
}

/**
 * Buyer makes an offer on a negotiable listing. Offers never hold stock. An offer below the seller's private
 * minimum is recorded as auto-declined and the buyer is told to try higher — the minimum is never revealed.
 */
export async function makeOffer(ctx: AppContext, raw: unknown): Promise<OfferResult> {
  const user = requireVerifiedUser(ctx);
  const input = parseInput(makeOfferInput, raw);
  return withIdempotency(ctx.pool, { scope: 'offer.make', actorId: user.userId, key: input.idempotencyKey, request: input }, async () => {
    await enforceRateLimit(ctx.pool, `offer.make:${user.userId}`, 30, 3600, 'You’ve made a lot of offers recently. Please wait a while and try again.');
    const settings = await getSettings(ctx.pool);
    const pre = await loadListing(ctx.pool, input.listingId);
    if (!pre || ['draft', 'removed'].includes(pre.status)) throw new DomainError('NOT_FOUND', 'Item not found.');
    if (await maybeOne(ctx.pool, 'SELECT 1 AS ok FROM shop_members WHERE shop_id = $1 AND user_id = $2', [pre.shop_id, user.userId])) {
      throw new DomainError('FORBIDDEN', 'You can’t make an offer on your own item.');
    }
    await assertNotBlocked(ctx.pool, user.userId, pre.shop_id, 'make offers here');

    return withTransaction(ctx.pool, async (tx) => {
      const conversation = await ensureListingConversation(tx, { listingId: pre.id, shopId: pre.shop_id, buyerUserId: user.userId });
      // Lock order: offer_threads first.
      let thread = await maybeOne<ThreadLock>(
        tx,
        `SELECT id, listing_id, shop_id, buyer_user_id, conversation_id, status FROM offer_threads
          WHERE listing_id = $1 AND buyer_user_id = $2 AND status IN ('open','accepted') FOR UPDATE`,
        [pre.id, user.userId],
      );
      if (!thread) {
        thread = await maybeOne<ThreadLock>(
          tx,
          `INSERT INTO offer_threads (listing_id, shop_id, buyer_user_id, conversation_id) VALUES ($1, $2, $3, $4)
           ON CONFLICT (listing_id, buyer_user_id) WHERE status IN ('open','accepted') DO NOTHING
           RETURNING id, listing_id, shop_id, buyer_user_id, conversation_id, status`,
          [pre.id, pre.shop_id, user.userId, conversation.id],
        );
        thread ??= await one<ThreadLock>(
          tx,
          `SELECT id, listing_id, shop_id, buyer_user_id, conversation_id, status FROM offer_threads
            WHERE listing_id = $1 AND buyer_user_id = $2 AND status IN ('open','accepted') FOR UPDATE`,
          [pre.id, user.userId],
        );
      }
      if (!thread.conversation_id) {
        await tx.query('UPDATE offer_threads SET conversation_id = $2 WHERE id = $1', [thread.id, conversation.id]);
        thread.conversation_id = conversation.id;
      }
      if (thread.status === 'accepted') throw new DomainError('INVALID_STATE', 'Your offer was already accepted. Continue to checkout to pay.');

      const l = (await loadListing(tx, pre.id))!;
      if (l.sale_mode !== 'negotiable') throw new DomainError('INVALID_STATE', 'This seller has a fixed price for this piece. You can buy it at the listed price.');
      if (l.shop_status !== 'active') throw new DomainError('INVALID_STATE', 'This shop isn’t taking offers right now.');
      if (l.status !== 'active' || (l.available ?? 0) < 1 || l.price_minor === null) {
        throw new DomainError('STOCK_CONFLICT', l.status === 'sold' ? 'This piece has sold.' : 'This piece is reserved or unavailable right now.');
      }
      if ((await buyerOffersToday(tx, thread.id)) >= settings.max_offers_per_thread_per_day) {
        throw new DomainError('RATE_LIMITED', 'You’ve reached today’s limit of offers on this item. Try again tomorrow.');
      }
      const pending = await maybeOne<OfferLock>(tx, `SELECT * FROM offers WHERE thread_id = $1 AND status = 'pending' FOR UPDATE`, [thread.id]);
      if (pending && pending.from_party === 'buyer' && new Date(pending.expires_at) > ctx.now()) {
        throw new DomainError('INVALID_STATE', 'You already have an offer waiting for a reply. Withdraw it first if you want to change the amount.');
      }
      const verdict = evaluateOfferAmount({ amountMinor: input.amount, askingMinor: l.price_minor, minOfferMinor: l.min_offer_minor, fromParty: 'buyer' });
      if (pending) {
        // A seller counter (or a stale offer) is superseded by the buyer's new offer.
        await tx.query(`UPDATE offers SET status = $2, responded_at = now() WHERE id = $1`, [
          pending.id,
          new Date(pending.expires_at) > ctx.now() ? 'countered' : 'expired',
        ]);
      }
      const seq = (await one<{ n: number }>(tx, 'SELECT coalesce(max(seq), 0)::int + 1 AS n FROM offers WHERE thread_id = $1', [thread.id])).n;
      const autoDeclined = verdict === 'auto_decline';
      const expiresAt = new Date(ctx.now().getTime() + settings.offer_expiry_hours * 3_600_000);
      const offer = await one<{ id: string }>(
        tx,
        `INSERT INTO offers (thread_id, seq, from_party, amount_minor, note, status, expires_at, responded_at)
         VALUES ($1, $2, 'buyer', $3, $4, $5, $6, $7) RETURNING id`,
        [thread.id, seq, input.amount, input.note, autoDeclined ? 'auto_declined' : 'pending', expiresAt, autoDeclined ? ctx.now() : null],
      );
      await insertMessage(tx, { conversationId: conversation.id, senderUserId: user.userId, kind: 'offer', body: offerCardBody('buyer', input.amount, input.note), offerId: offer.id });
      await tx.query('UPDATE offer_threads SET updated_at = now() WHERE id = $1', [thread.id]);
      await bumpListingStat(tx, l.id, 'offers');
      if (autoDeclined) {
        await postSystemMessage(tx, {
          conversationId: conversation.id,
          body: 'This offer was declined automatically because it’s below what the seller accepts.',
          actorUserId: user.userId,
          offerId: offer.id,
        });
        return { status: 'auto_declined' as const, threadId: thread.id, conversationId: conversation.id, offerId: offer.id, message: BELOW_MINIMUM_MESSAGE, checkoutPath: null };
      }
      await notifyParty(tx, thread, 'seller', {
        kind: 'offer_received',
        title: `New offer of ${formatNaira(input.amount)} on “${l.title}”`,
        body: `Reply within ${settings.offer_expiry_hours} hours or it expires.`,
        dedupeKey: `offer:${offer.id}`,
      });
      return {
        status: 'pending' as const,
        threadId: thread.id,
        conversationId: conversation.id,
        offerId: offer.id,
        message: `Offer sent. The seller has ${settings.offer_expiry_hours} hours to reply. Your offer doesn’t hold the item until it’s accepted.`,
        checkoutPath: null,
      };
    });
  });
}

/**
 * Responds to the latest pending offer in a thread. The counterparty accepts, rejects or counters; the author
 * withdraws. Acceptance atomically reserves the piece at the agreed price for a short hold — if another buyer or
 * the seller got the last unit first, the result is an explicit "unavailable", never a payable promise.
 */
export async function respondToOffer(ctx: AppContext, raw: unknown): Promise<OfferResult> {
  const user = requireVerifiedUser(ctx);
  const input = parseInput(respondToOfferInput, raw);
  const run = async (): Promise<OfferResult> => {
    const peek = await maybeOne<{ thread_id: string; shop_id: string; buyer_user_id: string; is_member: boolean }>(
      ctx.pool,
      `SELECT o.thread_id, t.shop_id, t.buyer_user_id, EXISTS (SELECT 1 FROM shop_members m WHERE m.shop_id = t.shop_id AND m.user_id = $2) AS is_member
         FROM offers o JOIN offer_threads t ON t.id = o.thread_id WHERE o.id = $1`,
      [input.offerId, user.userId],
    );
    if (!peek) throw new DomainError('NOT_FOUND', 'Offer not found.');
    const party: OfferParty | null = peek.buyer_user_id === user.userId ? 'buyer' : peek.is_member ? 'seller' : null;
    if (!party) throw new DomainError('NOT_FOUND', 'Offer not found.');
    if (input.action === 'accept' || input.action === 'counter') await assertNotBlocked(ctx.pool, peek.buyer_user_id, peek.shop_id, 'respond to offers here');
    const settings = await getSettings(ctx.pool);

    return withTransaction(ctx.pool, async (tx) => {
      const thread = await one<ThreadLock>(
        tx,
        'SELECT id, listing_id, shop_id, buyer_user_id, conversation_id, status FROM offer_threads WHERE id = $1 FOR UPDATE',
        [peek.thread_id],
      );
      const offer = await one<OfferLock>(tx, 'SELECT * FROM offers WHERE id = $1 FOR UPDATE', [input.offerId]);
      if (thread.status !== 'open') throw new DomainError('INVALID_STATE', 'This negotiation has ended.');
      assertOfferAction({ fromParty: offer.from_party, amountMinor: offer.amount_minor, status: offer.status, expiresAt: new Date(offer.expires_at) }, party, input.action, ctx.now());
      const other: OfferParty = party === 'buyer' ? 'seller' : 'buyer';
      const conversationId = thread.conversation_id;
      const base = { threadId: thread.id, conversationId, offerId: offer.id, checkoutPath: null };
      const actorName = party === 'buyer' ? 'The buyer' : 'The seller';

      if (input.action === 'withdraw') {
        await tx.query(`UPDATE offers SET status = 'withdrawn', responded_at = now() WHERE id = $1`, [offer.id]);
        if (party === 'buyer') await tx.query(`UPDATE offer_threads SET status = 'withdrawn', updated_at = now() WHERE id = $1`, [thread.id]);
        else await tx.query(`UPDATE offer_threads SET updated_at = now() WHERE id = $1`, [thread.id]);
        if (conversationId) await postSystemMessage(tx, { conversationId, body: `${actorName} withdrew the offer of ${formatNaira(offer.amount_minor)}.`, actorUserId: user.userId, offerId: offer.id });
        return { ...base, status: 'withdrawn' as const, message: 'Offer withdrawn.' };
      }

      if (input.action === 'reject') {
        await tx.query(`UPDATE offers SET status = 'rejected', responded_at = now() WHERE id = $1`, [offer.id]);
        await tx.query(`UPDATE offer_threads SET updated_at = now() WHERE id = $1`, [thread.id]);
        if (conversationId) {
          await postSystemMessage(tx, {
            conversationId,
            body: `${actorName} declined the offer of ${formatNaira(offer.amount_minor)}${input.note ? ` — “${input.note}”` : ''}.`,
            actorUserId: user.userId,
            offerId: offer.id,
          });
        }
        await notifyParty(tx, thread, other, { kind: 'offer_declined', title: `Your offer of ${formatNaira(offer.amount_minor)} was declined`, dedupeKey: `offer-declined:${offer.id}` });
        return { ...base, status: 'rejected' as const, message: 'Offer declined.' };
      }

      const l = (await loadListing(tx, thread.listing_id))!;

      if (input.action === 'counter') {
        if (l.price_minor === null) throw new DomainError('INVALID_STATE', 'This item has no price.');
        const amount = input.counterAmount!;
        if (party === 'buyer' && (await buyerOffersToday(tx, thread.id)) >= settings.max_offers_per_thread_per_day) {
          throw new DomainError('RATE_LIMITED', 'You’ve reached today’s limit of offers on this item. Try again tomorrow.');
        }
        const verdict = evaluateOfferAmount({ amountMinor: amount, askingMinor: l.price_minor, minOfferMinor: l.min_offer_minor, fromParty: party });
        await tx.query(`UPDATE offers SET status = 'countered', responded_at = now() WHERE id = $1`, [offer.id]);
        const autoDeclined = verdict === 'auto_decline';
        const seq = offer.seq + 1;
        const counter = await one<{ id: string }>(
          tx,
          `INSERT INTO offers (thread_id, seq, from_party, amount_minor, note, status, expires_at, responded_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [thread.id, seq, party, amount, input.note, autoDeclined ? 'auto_declined' : 'pending', new Date(ctx.now().getTime() + settings.offer_expiry_hours * 3_600_000), autoDeclined ? ctx.now() : null],
        );
        await tx.query(`UPDATE offer_threads SET updated_at = now() WHERE id = $1`, [thread.id]);
        if (conversationId) {
          await insertMessage(tx, { conversationId, senderUserId: user.userId, kind: 'offer', body: offerCardBody(party, amount, input.note), offerId: counter.id });
          if (autoDeclined) {
            await postSystemMessage(tx, { conversationId, body: 'This offer was declined automatically because it’s below what the seller accepts.', actorUserId: user.userId, offerId: counter.id });
          }
        }
        if (autoDeclined) return { ...base, offerId: counter.id, status: 'auto_declined' as const, message: BELOW_MINIMUM_MESSAGE };
        await bumpListingStat(tx, l.id, 'offers');
        await notifyParty(tx, thread, other, {
          kind: 'offer_countered',
          title: `${party === 'buyer' ? 'The buyer' : 'The seller'} countered with ${formatNaira(amount)} on “${l.title}”`,
          dedupeKey: `offer:${counter.id}`,
        });
        return { ...base, offerId: counter.id, status: 'countered' as const, message: `Counteroffer of ${formatNaira(amount)} sent.` };
      }

      // ACCEPT: one transaction — thread locked above, then the inventory authority reserves the piece.
      const expiresAt = new Date(ctx.now().getTime() + settings.offer_acceptance_hold_minutes * 60_000);
      let reservationId: string;
      try {
        if (l.status !== 'active' && l.status !== 'reserved') throw new DomainError('STOCK_CONFLICT', UNAVAILABLE_MESSAGE);
        if (l.shop_status !== 'active') throw new DomainError('STOCK_CONFLICT', UNAVAILABLE_MESSAGE);
        const reservation = await reserveStock(tx, {
          listingId: l.id,
          buyerUserId: thread.buyer_user_id,
          quantity: 1,
          source: 'offer',
          sourceId: thread.id,
          unitPriceMinor: offer.amount_minor,
          expiresAt,
          actorUserId: user.userId,
        });
        reservationId = reservation.id;
      } catch (err) {
        if (!isDomainError(err) || err.code !== 'STOCK_CONFLICT') throw err;
        await tx.query(`UPDATE offers SET status = 'expired', responded_at = now() WHERE id = $1`, [offer.id]);
        await tx.query(`UPDATE offer_threads SET status = 'closed_unavailable', updated_at = now() WHERE id = $1`, [thread.id]);
        if (conversationId) {
          await postSystemMessage(tx, { conversationId, body: 'This offer couldn’t be accepted because the piece was just reserved or sold.', actorUserId: user.userId, offerId: offer.id });
        }
        await notifyParty(tx, thread, other, { kind: 'offer_unavailable', title: `“${l.title}” is no longer available`, dedupeKey: `offer-unavailable:${offer.id}`, exceptUserId: user.userId });
        return { ...base, status: 'unavailable' as const, message: UNAVAILABLE_MESSAGE };
      }
      await tx.query(`UPDATE offers SET status = 'accepted', responded_at = now() WHERE id = $1`, [offer.id]);
      await tx.query(`UPDATE offer_threads SET status = 'accepted', agreed_price_minor = $2, reservation_id = $3, updated_at = now() WHERE id = $1`, [
        thread.id,
        offer.amount_minor,
        reservationId,
      ]);
      const checkoutPath = `/checkout/new?offer=${thread.id}`;
      if (conversationId) {
        await postSystemMessage(tx, {
          conversationId,
          body: `Offer accepted at ${formatNaira(offer.amount_minor)}. The piece is held for the buyer for ${settings.offer_acceptance_hold_minutes} minutes — pay through checkout to complete the purchase.`,
          actorUserId: user.userId,
          offerId: offer.id,
        });
      }
      await notifyParty(tx, thread, 'buyer', {
        kind: 'offer_accepted',
        title: `Offer accepted: ${formatNaira(offer.amount_minor)} for “${l.title}”`,
        body: `Pay within ${settings.offer_acceptance_hold_minutes} minutes to keep it.`,
        link: checkoutPath,
        dedupeKey: `offer-accepted:${offer.id}`,
        exceptUserId: user.userId,
      });
      await notifyParty(tx, thread, 'seller', {
        kind: 'offer_accepted_seller',
        title: `Offer accepted at ${formatNaira(offer.amount_minor)} for “${l.title}”`,
        body: 'The piece is reserved for the buyer while they pay.',
        dedupeKey: `offer-accepted-seller:${offer.id}`,
        exceptUserId: user.userId,
      });
      await recordAudit(tx, ctx, { action: 'offer.accepted', targetKind: 'offer_thread', targetId: thread.id, data: { offerId: offer.id, amountMinor: offer.amount_minor, reservationId } });
      return {
        ...base,
        status: 'accepted' as const,
        message: party === 'buyer' ? 'Offer accepted. The piece is held for you — continue to checkout.' : 'Offer accepted. The piece is reserved for the buyer while they pay.',
        checkoutPath: party === 'buyer' ? checkoutPath : null,
      };
    });
  };
  return input.idempotencyKey ? withIdempotency(ctx.pool, { scope: 'offer.respond', actorId: user.userId, key: input.idempotencyKey, request: input }, run) : run();
}
