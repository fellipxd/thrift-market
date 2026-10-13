import { many, one } from '@thrift/database';
import { requireOwnShop } from '../core/authz';
import type { AppContext } from '../core/context';

export const INSIGHT_PERIODS = [7, 30, 90] as const;
export type InsightPeriod = (typeof INSIGHT_PERIODS)[number];

export interface SellerInsights {
  periodDays: InsightPeriod;
  since: string;
  /** When these figures were computed (they are read live from the records, no batch lag). */
  generatedAt: string;
  engagement: { views: number; saves: number; messages: number; offers: number };
  sales: { paidOrders: number; itemsSold: number; grossMinor: number; refundsMinor: number; sellerCancellations: number; conversionPct: number | null };
  offers: { received: number; accepted: number; countered: number; declined: number; expired: number; answeredPct: number | null };
  auctions: { ended: number; withBids: number; paid: number; bids: number; bidders: number };
  dispatch: { dispatched: number; late: number; onTimePct: number | null };
  stock: { active: number; outOfStock: number; reserved: number; drafts: number };
  daily: { day: string; views: number; saves: number }[];
  topListings: { id: string; title: string; status: string; views: number; saves: number; messages: number; offers: number; sold: number }[];
}

const pct = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

/**
 * Seller metrics for a period (R20). Views are counted once per shopper per day and exclude the shop's own team;
 * money figures here are activity indicators — the payouts page is the source for gross, refunds, fees, pending
 * and settled payouts. Shown in Africa/Lagos days.
 */
export async function sellerInsights(ctx: AppContext, periodDays: number = 30): Promise<SellerInsights> {
  const shop = await requireOwnShop(ctx.pool, ctx);
  const days = (INSIGHT_PERIODS as readonly number[]).includes(periodDays) ? (periodDays as InsightPeriod) : 30;
  const sinceDay = `(now() AT TIME ZONE 'Africa/Lagos')::date - ${days - 1}`;
  const sinceTs = `(${sinceDay})::timestamp AT TIME ZONE 'Africa/Lagos'`;
  const db = ctx.pool;
  const [engagement, sales, offers, auctions, dispatch, stock, daily, top, since] = await Promise.all([
    one<{ views: number; saves: number; messages: number; offers: number }>(
      db,
      `SELECT coalesce(sum(d.views),0)::int AS views, coalesce(sum(d.saves),0)::int AS saves, coalesce(sum(d.messages),0)::int AS messages, coalesce(sum(d.offers),0)::int AS offers
         FROM listing_daily_stats d JOIN listings l ON l.id = d.listing_id WHERE l.shop_id = $1 AND d.day >= ${sinceDay}`,
      [shop.id],
    ),
    one<{ paid: number; items: number; gross: number; refunds: number; cancels: number }>(
      db,
      `SELECT (SELECT count(*) FROM orders o WHERE o.shop_id = $1 AND o.paid_at >= ${sinceTs})::int AS paid,
              (SELECT coalesce(sum(oi.quantity),0) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.shop_id = $1 AND o.paid_at >= ${sinceTs} AND oi.cancelled_at IS NULL)::int AS items,
              (SELECT coalesce(sum(o.items_total_minor),0) FROM orders o WHERE o.shop_id = $1 AND o.paid_at >= ${sinceTs})::bigint AS gross,
              (SELECT coalesce(sum(r.amount_minor),0) FROM refunds r JOIN orders o ON o.id = r.order_id
                WHERE o.shop_id = $1 AND r.status = 'succeeded' AND r.confirmed_at >= ${sinceTs} AND r.reason NOT IN ('late_payment_after_release','duplicate_payment'))::bigint AS refunds,
              (SELECT count(*) FROM orders o WHERE o.shop_id = $1 AND o.cancelled_at >= ${sinceTs} AND o.paid_at IS NOT NULL
                  AND EXISTS (SELECT 1 FROM refunds r WHERE r.order_id = o.id AND r.reason = 'seller_cancelled'))::int AS cancels`,
      [shop.id],
    ),
    one<{ received: number; accepted: number; countered: number; declined: number; expired: number }>(
      db,
      `SELECT count(*)::int AS received,
              count(*) FILTER (WHERE f.status = 'accepted')::int AS accepted,
              count(*) FILTER (WHERE f.status = 'countered')::int AS countered,
              count(*) FILTER (WHERE f.status IN ('rejected','auto_declined'))::int AS declined,
              count(*) FILTER (WHERE f.status = 'expired')::int AS expired
         FROM offers f JOIN offer_threads t ON t.id = f.thread_id
        WHERE t.shop_id = $1 AND f.from_party = 'buyer' AND f.created_at >= ${sinceTs}`,
      [shop.id],
    ),
    one<{ ended: number; with_bids: number; paid: number; bids: number; bidders: number }>(
      db,
      `SELECT count(*) FILTER (WHERE a.status IN ('ended_no_bids','awaiting_payment','paid','failed_unpaid'))::int AS ended,
              count(*) FILTER (WHERE a.status IN ('awaiting_payment','paid','failed_unpaid'))::int AS with_bids,
              count(*) FILTER (WHERE a.status = 'paid')::int AS paid,
              coalesce(sum((SELECT count(*) FROM bids b WHERE b.auction_id = a.id)),0)::int AS bids,
              coalesce(sum((SELECT count(DISTINCT b.bidder_user_id) FROM bids b WHERE b.auction_id = a.id)),0)::int AS bidders
         FROM auctions a WHERE a.shop_id = $1 AND a.ends_at >= ${sinceTs} AND a.ends_at <= now()`,
      [shop.id],
    ),
    one<{ dispatched: number; late: number }>(
      db,
      `SELECT count(*)::int AS dispatched,
              count(*) FILTER (WHERE sh.dispatch_by IS NOT NULL AND o.dispatched_at > sh.dispatch_by)::int AS late
         FROM orders o JOIN shipments sh ON sh.order_id = o.id
        WHERE o.shop_id = $1 AND o.dispatched_at >= ${sinceTs} AND o.delivery_method <> 'pickup'`,
      [shop.id],
    ),
    one<{ active: number; out_of_stock: number; reserved: number; drafts: number }>(
      db,
      `SELECT count(*) FILTER (WHERE l.status = 'active' AND coalesce(st.quantity_available,0) > 0)::int AS active,
              count(*) FILTER (WHERE l.status = 'active' AND coalesce(st.quantity_available,0) = 0)::int AS out_of_stock,
              count(*) FILTER (WHERE l.status = 'reserved' OR coalesce(st.quantity_reserved,0) > 0)::int AS reserved,
              count(*) FILTER (WHERE l.status = 'draft')::int AS drafts
         FROM listings l LEFT JOIN inventory_stock st ON st.listing_id = l.id WHERE l.shop_id = $1`,
      [shop.id],
    ),
    many<{ day: string; views: number; saves: number }>(
      db,
      `SELECT to_char(g.day, 'YYYY-MM-DD') AS day, coalesce(sum(d.views),0)::int AS views, coalesce(sum(d.saves),0)::int AS saves
         FROM generate_series(${sinceDay}, (now() AT TIME ZONE 'Africa/Lagos')::date, interval '1 day') AS g(day)
         LEFT JOIN listing_daily_stats d ON d.day = g.day::date AND d.listing_id IN (SELECT id FROM listings WHERE shop_id = $1)
        GROUP BY g.day ORDER BY g.day`,
      [shop.id],
    ),
    many<{ id: string; title: string; status: string; views: number; saves: number; messages: number; offers: number; sold: number }>(
      db,
      `SELECT l.id, l.title, l.status,
              coalesce(sum(d.views),0)::int AS views, coalesce(sum(d.saves),0)::int AS saves,
              coalesce(sum(d.messages),0)::int AS messages, coalesce(sum(d.offers),0)::int AS offers,
              (SELECT coalesce(sum(oi.quantity),0) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                WHERE oi.listing_id = l.id AND o.paid_at >= ${sinceTs} AND oi.cancelled_at IS NULL)::int AS sold
         FROM listings l LEFT JOIN listing_daily_stats d ON d.listing_id = l.id AND d.day >= ${sinceDay}
        WHERE l.shop_id = $1 AND l.status <> 'draft'
        GROUP BY l.id
        ORDER BY views DESC, sold DESC, l.title
        LIMIT 10`,
      [shop.id],
    ),
    one<{ since: string }>(db, `SELECT to_char(${sinceDay}, 'YYYY-MM-DD') AS since`),
  ]);
  const answered = offers.accepted + offers.countered + offers.declined;
  return {
    periodDays: days,
    since: since.since,
    generatedAt: ctx.now().toISOString(),
    engagement,
    sales: {
      paidOrders: sales.paid,
      itemsSold: sales.items,
      grossMinor: Number(sales.gross),
      refundsMinor: Number(sales.refunds),
      sellerCancellations: sales.cancels,
      conversionPct: pct(sales.paid, engagement.views),
    },
    offers: { ...offers, answeredPct: pct(answered, answered + offers.expired) },
    auctions: { ended: auctions.ended, withBids: auctions.with_bids, paid: auctions.paid, bids: auctions.bids, bidders: auctions.bidders },
    dispatch: { dispatched: dispatch.dispatched, late: dispatch.late, onTimePct: pct(dispatch.dispatched - dispatch.late, dispatch.dispatched) },
    stock: { active: stock.active, outOfStock: stock.out_of_stock, reserved: stock.reserved, drafts: stock.drafts },
    daily,
    topListings: top,
  };
}
