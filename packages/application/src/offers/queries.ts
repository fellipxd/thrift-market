import { shopOffersInput } from '@thrift/contracts';
import { CONDITION_INFO, DomainError, type ConditionGrade, type OfferParty, type OfferStatus, type OfferThreadStatus } from '@thrift/domain';
import { many, maybeOne, type Queryable } from '@thrift/database';
import { requireOwnShop, requireUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { getSettings } from '../core/settings';
import { parseInput } from '../core/validation';
import { mediaPath } from '../media/media';

export const OFFER_STATUS_LABEL: Record<OfferStatus, string> = {
  pending: 'Waiting for a reply',
  countered: 'Countered',
  accepted: 'Accepted',
  rejected: 'Declined',
  withdrawn: 'Withdrawn',
  expired: 'Expired',
  auto_declined: 'Declined automatically',
};

export const OFFER_THREAD_STATUS_LABEL: Record<OfferThreadStatus, string> = {
  open: 'Negotiating',
  accepted: 'Accepted — awaiting payment',
  rejected: 'Declined',
  withdrawn: 'Withdrawn',
  expired: 'Hold expired',
  closed_unavailable: 'Item no longer available',
  completed: 'Paid',
};

export interface OfferView {
  id: string;
  seq: number;
  fromParty: OfferParty;
  amountMinor: number;
  note: string | null;
  status: OfferStatus;
  statusLabel: string;
  expiresAt: string;
  createdAt: string;
}

export interface OfferThreadView {
  id: string;
  listingId: string;
  conversationId: string | null;
  status: OfferThreadStatus;
  statusLabel: string;
  agreedPriceMinor: number | null;
  reservation: { id: string; status: string; expiresAt: string } | null;
  /** Buyer-only: where to pay once an offer is accepted and the hold is active. */
  checkoutPath: string | null;
  pending: OfferView | null;
  offers: OfferView[];
}

interface ThreadRow {
  id: string;
  listing_id: string;
  conversation_id: string | null;
  buyer_user_id: string;
  status: OfferThreadStatus;
  agreed_price_minor: number | null;
  reservation_id: string | null;
  r_status: string | null;
  r_expires_at: Date | null;
  [k: string]: unknown;
}

interface OfferRow {
  id: string;
  thread_id: string;
  seq: number;
  from_party: OfferParty;
  amount_minor: number;
  note: string | null;
  status: OfferStatus;
  expires_at: Date;
  created_at: Date;
  [k: string]: unknown;
}

function toOfferView(o: OfferRow): OfferView {
  return {
    id: o.id,
    seq: o.seq,
    fromParty: o.from_party,
    amountMinor: o.amount_minor,
    note: o.note,
    status: o.status,
    statusLabel: OFFER_STATUS_LABEL[o.status],
    expiresAt: new Date(o.expires_at).toISOString(),
    createdAt: new Date(o.created_at).toISOString(),
  };
}

/**
 * Offer threads shown inside a conversation, newest first, with their offer history.
 * Never selects the listing's private minimum.
 */
export async function offerThreadsForConversation(db: Queryable, conversationId: string, viewer: { role: 'buyer' | 'seller'; now: Date }): Promise<OfferThreadView[]> {
  const threads = await many<ThreadRow>(
    db,
    `SELECT t.id, t.listing_id, t.conversation_id, t.buyer_user_id, t.status, t.agreed_price_minor, t.reservation_id,
            r.status AS r_status, r.expires_at AS r_expires_at
       FROM offer_threads t LEFT JOIN reservations r ON r.id = t.reservation_id
      WHERE t.conversation_id = $1 ORDER BY t.created_at DESC LIMIT 10`,
    [conversationId],
  );
  if (threads.length === 0) return [];
  const offers = await many<OfferRow>(
    db,
    `SELECT id, thread_id, seq, from_party, amount_minor, note, status, expires_at, created_at FROM offers WHERE thread_id = ANY($1::uuid[]) ORDER BY seq`,
    [threads.map((t) => t.id)],
  );
  return threads.map((t) => {
    const mine = offers.filter((o) => o.thread_id === t.id).map(toOfferView);
    const holdActive = t.status === 'accepted' && t.r_status !== null && ['active', 'payment_pending'].includes(t.r_status) && new Date(t.r_expires_at!) > viewer.now;
    return {
      id: t.id,
      listingId: t.listing_id,
      conversationId: t.conversation_id,
      status: t.status,
      statusLabel: OFFER_THREAD_STATUS_LABEL[t.status],
      agreedPriceMinor: t.agreed_price_minor,
      reservation: t.reservation_id && t.r_status ? { id: t.reservation_id, status: t.r_status, expiresAt: new Date(t.r_expires_at!).toISOString() } : null,
      checkoutPath: viewer.role === 'buyer' && holdActive ? `/checkout/new?offer=${t.id}` : null,
      pending: mine.find((o) => o.status === 'pending') ?? null,
      offers: mine,
    };
  });
}

export type ShopOfferFilter = 'needs_response' | 'awaiting_buyer' | 'accepted' | 'closed' | 'all';

export interface ShopOfferItem {
  threadId: string;
  conversationId: string | null;
  listing: { id: string; title: string; photoUrl: string | null; priceMinor: number | null };
  buyerName: string;
  status: OfferThreadStatus;
  statusLabel: string;
  latest: OfferView | null;
  agreedPriceMinor: number | null;
  reservationExpiresAt: string | null;
  updatedAt: string;
}

const FILTER_SQL: Record<ShopOfferFilter, string> = {
  needs_response: `t.status = 'open' AND EXISTS (SELECT 1 FROM offers p WHERE p.thread_id = t.id AND p.status = 'pending' AND p.from_party = 'buyer')`,
  awaiting_buyer: `t.status = 'open' AND EXISTS (SELECT 1 FROM offers p WHERE p.thread_id = t.id AND p.status = 'pending' AND p.from_party = 'seller')`,
  accepted: `t.status = 'accepted'`,
  closed: `t.status NOT IN ('open','accepted')`,
  all: 'true',
};

/** Seller view of the shop's negotiations with counts per filter (for the offers page and overview). */
export async function shopOffers(ctx: AppContext, raw: unknown = {}): Promise<{ items: ShopOfferItem[]; counts: Record<ShopOfferFilter, number>; serverNow: string }> {
  const shop = await requireOwnShop(ctx.pool, ctx);
  const input = parseInput(shopOffersInput, raw);
  const rows = await many<
    ThreadRow & { title: string; price_minor: number | null; photo_key: string | null; buyer_name: string; updated_at: Date } & Partial<{ [K in `o_${string}`]: unknown }>
  >(
    ctx.pool,
    `SELECT t.id, t.listing_id, t.conversation_id, t.buyer_user_id, t.status, t.agreed_price_minor, t.reservation_id, t.updated_at,
            r.status AS r_status, r.expires_at AS r_expires_at,
            l.title, l.price_minor, u.display_name AS buyer_name,
            (SELECT ma.storage_key FROM listing_media lm JOIN media_assets ma ON ma.id = lm.media_id WHERE lm.listing_id = l.id ORDER BY lm.position LIMIT 1) AS photo_key
       FROM offer_threads t
       JOIN listings l ON l.id = t.listing_id
       JOIN users u ON u.id = t.buyer_user_id
       LEFT JOIN reservations r ON r.id = t.reservation_id
      WHERE t.shop_id = $1 AND ${FILTER_SQL[input.status]}
      ORDER BY t.updated_at DESC LIMIT $2`,
    [shop.id, input.limit],
  );
  const latest = rows.length
    ? await many<OfferRow>(
        ctx.pool,
        `SELECT DISTINCT ON (thread_id) id, thread_id, seq, from_party, amount_minor, note, status, expires_at, created_at
           FROM offers WHERE thread_id = ANY($1::uuid[]) ORDER BY thread_id, seq DESC`,
        [rows.map((r) => r.id)],
      )
    : [];
  const countRow = await maybeOne<Record<ShopOfferFilter, number>>(
    ctx.pool,
    `SELECT ${(Object.keys(FILTER_SQL) as ShopOfferFilter[]).map((k) => `count(*) FILTER (WHERE ${FILTER_SQL[k]})::int AS ${k}`).join(', ')}
       FROM offer_threads t WHERE t.shop_id = $1`,
    [shop.id],
  );
  return {
    items: rows.map((r) => {
      const o = latest.find((x) => x.thread_id === r.id);
      return {
        threadId: r.id,
        conversationId: r.conversation_id,
        listing: { id: r.listing_id, title: r.title, photoUrl: r.photo_key ? mediaPath(r.photo_key, 'thumb') : null, priceMinor: r.price_minor },
        buyerName: r.buyer_name,
        status: r.status,
        statusLabel: OFFER_THREAD_STATUS_LABEL[r.status],
        latest: o ? toOfferView(o) : null,
        agreedPriceMinor: r.agreed_price_minor,
        reservationExpiresAt: r.status === 'accepted' && r.r_expires_at ? new Date(r.r_expires_at).toISOString() : null,
        updatedAt: new Date(r.updated_at).toISOString(),
      };
    }),
    counts: countRow ?? { needs_response: 0, awaiting_buyer: 0, accepted: 0, closed: 0, all: 0 },
    serverNow: ctx.now().toISOString(),
  };
}

export interface OfferContext {
  listing: { id: string; title: string; photoUrl: string | null; priceMinor: number; shopName: string; shopSlug: string; conditionLabel: string | null };
  /** Why an offer can't be made right now (shown instead of the form). */
  blocked: string | null;
  openThread: { id: string; conversationId: string | null; status: OfferThreadStatus; pending: OfferView | null; checkoutPath: string | null } | null;
  expiryHours: number;
  maxOffersPerDay: number;
  offersLeftToday: number;
}

/** Everything the "make an offer" page needs. The private minimum is never part of the result. */
export async function getOfferContext(ctx: AppContext, listingId: string): Promise<OfferContext> {
  const user = requireUser(ctx);
  if (!/^[0-9a-f-]{36}$/i.test(listingId)) throw new DomainError('NOT_FOUND', 'Item not found.');
  const settings = await getSettings(ctx.pool);
  const l = await maybeOne<{
    id: string; title: string; status: string; sale_mode: string; price_minor: number | null; condition: string | null; shop_name: string; shop_slug: string;
    shop_status: string; shop_id: string; available: number | null; is_member: boolean; photo_key: string | null; [k: string]: unknown;
  }>(
    ctx.pool,
    `SELECT l.id, l.title, l.status, l.sale_mode, l.price_minor, l.condition, s.name AS shop_name, s.slug AS shop_slug, s.status AS shop_status, s.id AS shop_id,
            st.quantity_available AS available,
            EXISTS (SELECT 1 FROM shop_members m WHERE m.shop_id = s.id AND m.user_id = $2) AS is_member,
            (SELECT ma.storage_key FROM listing_media lm JOIN media_assets ma ON ma.id = lm.media_id WHERE lm.listing_id = l.id ORDER BY lm.position LIMIT 1) AS photo_key
       FROM listings l JOIN shops s ON s.id = l.shop_id LEFT JOIN inventory_stock st ON st.listing_id = l.id
      WHERE l.id = $1 AND l.status NOT IN ('draft','removed')`,
    [listingId, user.userId],
  );
  if (!l || l.price_minor === null) throw new DomainError('NOT_FOUND', 'Item not found.');
  const thread = await maybeOne<ThreadRow>(
    ctx.pool,
    `SELECT t.id, t.listing_id, t.conversation_id, t.buyer_user_id, t.status, t.agreed_price_minor, t.reservation_id, r.status AS r_status, r.expires_at AS r_expires_at
       FROM offer_threads t LEFT JOIN reservations r ON r.id = t.reservation_id
      WHERE t.listing_id = $1 AND t.buyer_user_id = $2 AND t.status IN ('open','accepted')`,
    [l.id, user.userId],
  );
  let openThread: OfferContext['openThread'] = null;
  if (thread && thread.conversation_id) {
    const [view] = (await offerThreadsForConversation(ctx.pool, thread.conversation_id, { role: 'buyer', now: ctx.now() })).filter((t) => t.id === thread.id);
    openThread = { id: thread.id, conversationId: thread.conversation_id, status: thread.status, pending: view?.pending ?? null, checkoutPath: view?.checkoutPath ?? null };
  }
  const usedToday = thread
    ? ((await maybeOne<{ n: number }>(ctx.pool, `SELECT count(*)::int AS n FROM offers WHERE thread_id = $1 AND from_party = 'buyer' AND created_at > now() - interval '24 hours'`, [thread.id]))?.n ?? 0)
    : 0;
  let blocked: string | null = null;
  if (l.is_member) blocked = 'You can’t make an offer on your own item.';
  else if (l.sale_mode !== 'negotiable') blocked = 'This seller has a fixed price for this piece. You can buy it at the listed price.';
  else if (l.shop_status !== 'active') blocked = 'This shop isn’t taking offers right now.';
  else if (l.status !== 'active' || (l.available ?? 0) < 1) blocked = l.status === 'sold' ? 'This piece has sold.' : 'This piece is reserved or unavailable right now.';
  else if (thread?.status === 'accepted') blocked = 'Your offer was accepted. Continue to checkout to pay.';
  else if (usedToday >= settings.max_offers_per_thread_per_day) blocked = 'You’ve reached today’s limit of offers on this item. Try again tomorrow.';
  return {
    listing: {
      id: l.id,
      title: l.title,
      photoUrl: l.photo_key ? mediaPath(l.photo_key, 'thumb') : null,
      priceMinor: l.price_minor,
      shopName: l.shop_name,
      shopSlug: l.shop_slug,
      conditionLabel: l.condition ? (CONDITION_INFO[l.condition as ConditionGrade]?.label ?? null) : null,
    },
    blocked,
    openThread,
    expiryHours: settings.offer_expiry_hours,
    maxOffersPerDay: settings.max_offers_per_thread_per_day,
    offersLeftToday: Math.max(0, settings.max_offers_per_thread_per_day - usedToday),
  };
}
