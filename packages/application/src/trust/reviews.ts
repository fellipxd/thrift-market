import { moderateReviewInput, sellerReplyInput, submitReviewInput } from '@thrift/contracts';
import { DomainError, REPUTATION_THRESHOLDS, REPUTATION_TIER_LABEL, type ReputationTier } from '@thrift/domain';
import { isUniqueViolation, many, maybeOne, one, withTransaction, type Queryable } from '@thrift/database';
import { recordAudit } from '../core/audit';
import { requireOwnShop, requireStaff, requireUser, requireVerifiedUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { enqueue } from '../core/outbox';
import { enforceRateLimit } from '../core/rate-limit';
import { getSettings } from '../core/settings';
import { parseInput } from '../core/validation';
import { notifyUser } from '../notifications/notify';
import { refreshShopReputation } from './reputation';

const REPLY_EDIT_HOURS = 48;

interface EligibleItemRow {
  order_item_id: string;
  order_id: string;
  shop_id: string;
  title: string;
  delivered_at: Date | null;
  status: string;
  fulfilment_status: string;
  buyer_confirmed_at: Date | null;
  review_id: string | null;
  [k: string]: unknown;
}

/**
 * Only the buyer of an order item can review it, once, after delivery (delivered or buyer-confirmed) and within
 * the review window. Undelivered, cancelled and unpaid orders can't be reviewed.
 */
function eligibility(row: EligibleItemRow, windowDays: number, now: Date): { canReview: boolean; reason: string | null; windowEndsAt: Date | null } {
  if (row.review_id) return { canReview: false, reason: 'You’ve already reviewed this item.', windowEndsAt: null };
  if (!['confirmed', 'completed'].includes(row.status)) return { canReview: false, reason: 'Only completed purchases can be reviewed.', windowEndsAt: null };
  const deliveredAt = row.buyer_confirmed_at ?? row.delivered_at;
  if (!deliveredAt || !(row.fulfilment_status === 'delivered' || row.buyer_confirmed_at)) {
    return { canReview: false, reason: 'You can review once the item has been delivered.', windowEndsAt: null };
  }
  const windowEndsAt = new Date(new Date(deliveredAt).getTime() + windowDays * 86_400_000);
  if (now > windowEndsAt) return { canReview: false, reason: 'The review window for this order has closed.', windowEndsAt };
  return { canReview: true, reason: null, windowEndsAt };
}

const ITEM_SQL = `
  SELECT oi.id AS order_item_id, o.id AS order_id, o.shop_id, coalesce(oi.snapshot->>'title', 'Item') AS title,
         o.delivered_at, o.status, o.fulfilment_status, o.buyer_confirmed_at, rv.id AS review_id
    FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN reviews rv ON rv.order_item_id = oi.id`;

export interface ReviewView {
  id: string;
  shopId: string;
  authorName: string;
  itemTitle: string;
  overall: number;
  accuracy: number;
  communication: number;
  delivery: number;
  body: string;
  status: 'published' | 'hidden' | 'removed';
  sellerReply: string | null;
  sellerRepliedAt: string | null;
  canEditReply: boolean;
  createdAt: string;
  verifiedPurchase: true;
}

interface ReviewRow {
  id: string;
  shop_id: string;
  author_name: string;
  item_title: string;
  rating_overall: number;
  rating_accuracy: number;
  rating_communication: number;
  rating_delivery: number;
  body: string;
  status: ReviewView['status'];
  seller_reply: string | null;
  seller_replied_at: Date | null;
  created_at: Date;
  [k: string]: unknown;
}

const REVIEW_SELECT = `
  rv.id, rv.shop_id, split_part(u.display_name, ' ', 1) AS author_name, coalesce(oi.snapshot->>'title', 'Item') AS item_title,
  rv.rating_overall, rv.rating_accuracy, rv.rating_communication, rv.rating_delivery, rv.body, rv.status, rv.seller_reply, rv.seller_replied_at, rv.created_at`;
const REVIEW_FROM = `reviews rv JOIN users u ON u.id = rv.author_user_id JOIN order_items oi ON oi.id = rv.order_item_id`;

function toView(r: ReviewRow, now: Date, viewerIsSeller = false): ReviewView {
  return {
    id: r.id,
    shopId: r.shop_id,
    authorName: r.author_name || 'Buyer',
    itemTitle: r.item_title,
    overall: r.rating_overall,
    accuracy: r.rating_accuracy,
    communication: r.rating_communication,
    delivery: r.rating_delivery,
    body: r.body,
    status: r.status,
    sellerReply: r.seller_reply,
    sellerRepliedAt: r.seller_replied_at ? new Date(r.seller_replied_at).toISOString() : null,
    canEditReply: viewerIsSeller && (!r.seller_replied_at || now.getTime() - new Date(r.seller_replied_at).getTime() < REPLY_EDIT_HOURS * 3_600_000),
    createdAt: new Date(r.created_at).toISOString(),
    verifiedPurchase: true,
  };
}

export interface OrderReviewItem {
  orderItemId: string;
  title: string;
  canReview: boolean;
  reason: string | null;
  windowEndsAt: string | null;
  review: ReviewView | null;
}

/** For the order page: each item with whether the buyer can review it, or their existing review. */
export async function orderReviewItems(ctx: AppContext, orderId: string): Promise<OrderReviewItem[]> {
  const user = requireUser(ctx);
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) throw new DomainError('NOT_FOUND', 'Order not found.');
  const settings = await getSettings(ctx.pool);
  const rows = await many<EligibleItemRow & { buyer_user_id: string }>(ctx.pool, `${ITEM_SQL.replace('SELECT ', 'SELECT o.buyer_user_id, ')} WHERE o.id = $1`, [orderId]);
  if (rows.length === 0 || rows[0]!.buyer_user_id !== user.userId) return [];
  const reviews = await many<ReviewRow>(ctx.pool, `SELECT ${REVIEW_SELECT} FROM ${REVIEW_FROM} WHERE rv.order_id = $1`, [orderId]);
  return rows.map((r) => {
    const e = eligibility(r, settings.review_window_days, ctx.now());
    const review = reviews.find((x) => x.id === r.review_id);
    return {
      orderItemId: r.order_item_id,
      title: r.title,
      canReview: e.canReview,
      reason: e.reason,
      windowEndsAt: e.windowEndsAt?.toISOString() ?? null,
      review: review ? toView(review, ctx.now()) : null,
    };
  });
}

/** Verified-purchase review with dimension ratings. Recomputes the shop's reputation. */
export async function submitReview(ctx: AppContext, raw: unknown): Promise<{ reviewId: string }> {
  const user = requireVerifiedUser(ctx);
  const input = parseInput(submitReviewInput, raw);
  await enforceRateLimit(ctx.pool, `review:${user.userId}`, 20, 86_400, 'You’ve written a lot of reviews today. Try again tomorrow.');
  const settings = await getSettings(ctx.pool);
  try {
    return await withTransaction(ctx.pool, async (tx) => {
      const row = await maybeOne<EligibleItemRow & { buyer_user_id: string; order_number: string }>(
        tx,
        `${ITEM_SQL.replace('SELECT ', 'SELECT o.buyer_user_id, o.number AS order_number, ')} WHERE oi.id = $1 FOR UPDATE OF o`,
        [input.orderItemId],
      );
      if (!row || row.buyer_user_id !== user.userId) throw new DomainError('NOT_FOUND', 'Order item not found.');
      const e = eligibility(row, settings.review_window_days, ctx.now());
      if (!e.canReview) throw new DomainError('INVALID_STATE', e.reason ?? 'This item can’t be reviewed.');
      const r = await one<{ id: string }>(
        tx,
        `INSERT INTO reviews (order_item_id, order_id, shop_id, author_user_id, rating_overall, rating_accuracy, rating_communication, rating_delivery, body)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [row.order_item_id, row.order_id, row.shop_id, user.userId, input.overall, input.accuracy, input.communication, input.delivery, input.body],
      );
      await refreshShopReputation(tx, row.shop_id);
      await enqueue(tx, { topic: 'review.created', aggregateId: r.id, payload: { reviewId: r.id, shopId: row.shop_id }, dedupeKey: `review.created:${r.id}` });
      const owner = await one<{ owner_user_id: string; slug: string }>(tx, 'SELECT owner_user_id, slug FROM shops WHERE id = $1', [row.shop_id]);
      await notifyUser(tx, {
        userId: owner.owner_user_id,
        topic: 'transactional',
        kind: 'review_received',
        title: `New ${input.overall}-star review for order ${row.order_number}`,
        body: 'You can reply once. Reviews can only be removed for clear policy violations.',
        link: '/sell/reviews',
        dedupeKey: `review:${r.id}`,
      });
      return { reviewId: r.id };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new DomainError('CONFLICT', 'You’ve already reviewed this item.');
    throw err;
  }
}

/** The seller replies once; the reply can be edited for 48 hours. */
export async function replyToReview(ctx: AppContext, raw: unknown): Promise<{ reviewId: string }> {
  const user = requireUser(ctx);
  const input = parseInput(sellerReplyInput, raw);
  return withTransaction(ctx.pool, async (tx) => {
    const r = await maybeOne<{ id: string; shop_id: string; seller_replied_at: Date | null; status: string; is_member: boolean }>(
      tx,
      `SELECT rv.id, rv.shop_id, rv.seller_replied_at, rv.status,
              EXISTS (SELECT 1 FROM shop_members m WHERE m.shop_id = rv.shop_id AND m.user_id = $2) AS is_member
         FROM reviews rv WHERE rv.id = $1 FOR UPDATE`,
      [input.reviewId, user.userId],
    );
    if (!r || !r.is_member) throw new DomainError('NOT_FOUND', 'Review not found.');
    if (r.status === 'removed') throw new DomainError('INVALID_STATE', 'This review was removed.');
    if (r.seller_replied_at && ctx.now().getTime() - new Date(r.seller_replied_at).getTime() > REPLY_EDIT_HOURS * 3_600_000) {
      throw new DomainError('INVALID_STATE', `Replies can be edited for ${REPLY_EDIT_HOURS} hours.`);
    }
    await tx.query(`UPDATE reviews SET seller_reply = $2, seller_replied_at = coalesce(seller_replied_at, $3), updated_at = now() WHERE id = $1`, [r.id, input.reply, ctx.now()]);
    return { reviewId: r.id };
  });
}

/**
 * Trust & safety hides or removes a review only for a demonstrable policy violation (reason required), or
 * restores it. Sellers have no way to suppress a legitimate negative review.
 */
export async function moderateReview(ctx: AppContext, raw: unknown, opts: { reportId?: string | null } = {}): Promise<{ reviewId: string; status: string }> {
  const staff = requireStaff(ctx, 'trust_safety', 'admin');
  const input = parseInput(moderateReviewInput, raw);
  return withTransaction(ctx.pool, (tx) => applyReviewModeration(tx, ctx, staff.userId, input, opts.reportId ?? null));
}

export async function applyReviewModeration(
  tx: Queryable,
  ctx: AppContext,
  staffUserId: string,
  input: { reviewId: string; action: 'hide' | 'remove' | 'restore'; reason: string },
  reportId: string | null,
): Promise<{ reviewId: string; status: string }> {
  const r = await maybeOne<{ id: string; shop_id: string; author_user_id: string; status: string }>(tx, 'SELECT id, shop_id, author_user_id, status FROM reviews WHERE id = $1 FOR UPDATE', [input.reviewId]);
  if (!r) throw new DomainError('NOT_FOUND', 'Review not found.');
  const status = input.action === 'restore' ? 'published' : input.action === 'hide' ? 'hidden' : 'removed';
  await tx.query(`UPDATE reviews SET status = $2, moderated_by = $3, moderation_reason = $4, updated_at = now() WHERE id = $1`, [r.id, status, staffUserId, input.reason]);
  await tx.query(`INSERT INTO moderation_actions (actor_user_id, target_kind, target_id, action, reason, report_id) VALUES ($1, 'review', $2, $3, $4, $5)`, [
    staffUserId,
    r.id,
    `review_${input.action}`,
    input.reason,
    reportId,
  ]);
  await recordAudit(tx, ctx, { action: `review.${input.action}`, targetKind: 'review', targetId: r.id, reason: input.reason });
  await refreshShopReputation(tx, r.shop_id);
  await notifyUser(tx, {
    userId: r.author_user_id,
    topic: 'transactional',
    kind: 'review_moderated',
    title: input.action === 'restore' ? 'Your review is visible again' : 'Your review was hidden by Thrift Market',
    body: input.action === 'restore' ? input.reason : `Reason: ${input.reason}. If you think this is a mistake, contact support to appeal.`,
    link: '/help',
    dedupeKey: `review-moderated:${r.id}:${input.action}:${Date.now()}`,
  });
  return { reviewId: r.id, status };
}

export interface ShopReviewsPage {
  shop: { id: string; name: string; slug: string };
  summary: {
    count: number;
    averages: { overall: number | null; accuracy: number | null; communication: number | null; delivery: number | null };
    distribution: Record<1 | 2 | 3 | 4 | 5, number>;
    completedOrders: number;
    tier: ReputationTier;
    tierLabel: string;
    isNew: boolean;
    sampleText: string;
  };
  reviews: ReviewView[];
  nextCursor: string | null;
}

/** Public shop reviews: published only, with dimension averages and an explicit sample size. */
export async function shopReviews(ctx: AppContext, slug: string, opts: { cursor?: string | null } = {}): Promise<ShopReviewsPage> {
  const shop = await maybeOne<{ id: string; name: string; slug: string; status: string; completed_orders: number; reputation_tier: ReputationTier; is_member: boolean }>(
    ctx.pool,
    `SELECT s.id, s.name, s.slug, s.status, s.completed_orders, s.reputation_tier,
            EXISTS (SELECT 1 FROM shop_members m WHERE m.shop_id = s.id AND m.user_id = $2) AS is_member
       FROM shops s WHERE s.slug = $1`,
    [slug, ctx.actor.kind === 'user' ? ctx.actor.userId : null],
  );
  if (!shop || (shop.status === 'draft' && !shop.is_member)) throw new DomainError('NOT_FOUND', 'Shop not found.');
  const agg = await one<{ n: number; o: number | null; a: number | null; c: number | null; d: number | null; s1: number; s2: number; s3: number; s4: number; s5: number }>(
    ctx.pool,
    `SELECT count(*)::int AS n, round(avg(rating_overall), 2)::float AS o, round(avg(rating_accuracy), 2)::float AS a,
            round(avg(rating_communication), 2)::float AS c, round(avg(rating_delivery), 2)::float AS d,
            count(*) FILTER (WHERE rating_overall = 1)::int AS s1, count(*) FILTER (WHERE rating_overall = 2)::int AS s2,
            count(*) FILTER (WHERE rating_overall = 3)::int AS s3, count(*) FILTER (WHERE rating_overall = 4)::int AS s4,
            count(*) FILTER (WHERE rating_overall = 5)::int AS s5
       FROM reviews WHERE shop_id = $1 AND status = 'published'`,
    [shop.id],
  );
  const offset = Math.max(0, Number.parseInt(opts.cursor ?? '0', 10) || 0);
  const rows = await many<ReviewRow>(
    ctx.pool,
    `SELECT ${REVIEW_SELECT} FROM ${REVIEW_FROM} WHERE rv.shop_id = $1 AND rv.status = 'published' ORDER BY rv.created_at DESC, rv.id LIMIT 21 OFFSET $2`,
    [shop.id, offset],
  );
  const isNew = shop.completed_orders < REPUTATION_THRESHOLDS.establishedMinOrders && shop.reputation_tier !== 'under_review';
  return {
    shop: { id: shop.id, name: shop.name, slug: shop.slug },
    summary: {
      count: agg.n,
      averages: { overall: agg.o, accuracy: agg.a, communication: agg.c, delivery: agg.d },
      distribution: { 1: agg.s1, 2: agg.s2, 3: agg.s3, 4: agg.s4, 5: agg.s5 },
      completedOrders: shop.completed_orders,
      tier: shop.reputation_tier,
      tierLabel: isNew ? REPUTATION_TIER_LABEL.new : REPUTATION_TIER_LABEL[shop.reputation_tier],
      isNew,
      sampleText: `${agg.n} review${agg.n === 1 ? '' : 's'} from ${shop.completed_orders} completed order${shop.completed_orders === 1 ? '' : 's'}`,
    },
    reviews: rows.slice(0, 20).map((r) => toView(r, ctx.now(), shop.is_member)),
    nextCursor: rows.length > 20 ? String(offset + 20) : null,
  };
}

/** The seller's own reviews (including hidden ones, so they can see moderation outcomes), newest first. */
export async function sellerReviews(ctx: AppContext): Promise<ReviewView[]> {
  const shop = await requireOwnShop(ctx.pool, ctx);
  const rows = await many<ReviewRow>(ctx.pool, `SELECT ${REVIEW_SELECT} FROM ${REVIEW_FROM} WHERE rv.shop_id = $1 ORDER BY rv.created_at DESC LIMIT 100`, [shop.id]);
  return rows.map((r) => toView(r, ctx.now(), true));
}

/** Staff list of recent and moderated reviews. */
export async function staffReviewList(ctx: AppContext, opts: { status?: string } = {}): Promise<(ReviewView & { shopName: string; moderationReason: string | null; openReports: number })[]> {
  requireStaff(ctx, 'trust_safety', 'admin');
  const where = opts.status === 'moderated' ? `rv.status <> 'published'` : opts.status === 'reported' ? `EXISTS (SELECT 1 FROM reports rp WHERE rp.target_kind = 'review' AND rp.target_id = rv.id AND rp.status = 'open')` : 'true';
  const rows = await many<ReviewRow & { shop_name: string; moderation_reason: string | null; open_reports: number }>(
    ctx.pool,
    `SELECT ${REVIEW_SELECT}, s.name AS shop_name, rv.moderation_reason,
            (SELECT count(*) FROM reports rp WHERE rp.target_kind = 'review' AND rp.target_id = rv.id AND rp.status = 'open')::int AS open_reports
       FROM ${REVIEW_FROM} JOIN shops s ON s.id = rv.shop_id WHERE ${where} ORDER BY rv.created_at DESC LIMIT 100`,
  );
  return rows.map((r) => ({ ...toView(r, ctx.now()), shopName: r.shop_name, moderationReason: r.moderation_reason, openReports: r.open_reports }));
}
