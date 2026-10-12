import { many } from '@thrift/database';
import { requireOwnShop } from '../core/authz';
import type { AppContext } from '../core/context';
import { getSettings } from '../core/settings';
import { PLACEMENT_LABEL, unusedPortion, type CampaignRow } from './shared';

export interface SellerPromotion {
  id: string;
  status: CampaignRow['status'];
  packageName: string;
  placementLabel: string;
  targetKind: 'listing' | 'shop';
  listingId: string | null;
  listingTitle: string | null;
  priceMinor: number;
  refundMinor: number;
  refundPendingMinor: number;
  createdAt: string;
  paidAt: string | null;
  startsAt: string | null;
  endsAt: string | null;
  endedAt: string | null;
  reviewReason: string | null;
  endReason: string | null;
  endedEarly: boolean;
  unusedMinor: number;
  impressions: number;
  clicks: number;
  attributedOrders: number;
  attributedSalesMinor: number;
  canPay: boolean;
  canCancel: boolean;
}

/**
 * The seller's promotions with their reporting. Impressions and clicks are deduplicated per shopper per day and
 * exclude bots and the shop's own team. Attributed orders are paid orders for the promoted item (or shop) placed
 * by a signed-in shopper within the attribution window after clicking — informational only, never a fee basis.
 */
export async function sellerPromotions(ctx: AppContext): Promise<{ promotions: SellerPromotion[]; attributionDays: number; generatedAt: string }> {
  const shop = await requireOwnShop(ctx.pool, ctx);
  const attributionDays = (await getSettings(ctx.pool)).promotion_attribution_days;
  const rows = await many<
    CampaignRow & {
      package_name: string;
      listing_title: string | null;
      impressions: number;
      clicks: number;
      refund_pending: number;
      attributed_orders: number;
      attributed_sales: number;
    }
  >(
    ctx.pool,
    `SELECT c.*, p.name AS package_name, l.title AS listing_title,
            coalesce((SELECT sum(d.impressions) FROM ad_daily_stats d WHERE d.campaign_id = c.id), 0)::int AS impressions,
            coalesce((SELECT sum(d.clicks) FROM ad_daily_stats d WHERE d.campaign_id = c.id), 0)::int AS clicks,
            coalesce((SELECT sum(r.amount_minor) FROM refunds r WHERE r.ad_campaign_id = c.id AND r.status IN ('requested','approved','processing')
                        AND r.reason <> 'duplicate_payment'), 0)::bigint AS refund_pending,
            att.orders AS attributed_orders, att.sales AS attributed_sales
       FROM ad_campaigns c
       JOIN ad_packages p ON p.id = c.package_id
       LEFT JOIN listings l ON l.id = c.listing_id
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS orders, coalesce(sum(o.items_total_minor), 0)::bigint AS sales
           FROM orders o
          WHERE o.shop_id = c.shop_id AND o.paid_at IS NOT NULL
            AND (c.target_kind = 'shop' OR EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.listing_id = c.listing_id))
            AND EXISTS (SELECT 1 FROM ad_clicks k WHERE k.campaign_id = c.id AND k.user_id = o.buyer_user_id
                          AND k.clicked_at <= o.created_at AND o.created_at < k.clicked_at + make_interval(days => $2))
       ) att ON true
      WHERE c.shop_id = $1
      ORDER BY c.created_at DESC
      LIMIT 100`,
    [shop.id, attributionDays],
  );
  return {
    attributionDays,
    generatedAt: ctx.now().toISOString(),
    promotions: rows.map((r) => {
      const unused = unusedPortion(r);
      return {
        id: r.id,
        status: r.status,
        packageName: r.package_name,
        placementLabel: PLACEMENT_LABEL[r.placement],
        targetKind: r.target_kind,
        listingId: r.listing_id,
        listingTitle: r.listing_title,
        priceMinor: Number(r.price_minor),
        refundMinor: Number(r.refund_minor),
        refundPendingMinor: Number(r.refund_pending),
        createdAt: new Date(r.created_at).toISOString(),
        paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null,
        startsAt: r.starts_at ? new Date(r.starts_at).toISOString() : null,
        endsAt: r.ends_at ? new Date(r.ends_at).toISOString() : null,
        endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : null,
        reviewReason: r.review_reason,
        endReason: r.end_reason,
        endedEarly: unused.unusedMinor > 0,
        unusedMinor: unused.unusedMinor,
        impressions: r.impressions,
        clicks: r.clicks,
        attributedOrders: r.attributed_orders,
        attributedSalesMinor: Number(r.attributed_sales),
        canPay: r.status === 'awaiting_payment',
        canCancel: ['awaiting_payment', 'pending_review', 'scheduled'].includes(r.status),
      };
    }),
  };
}
