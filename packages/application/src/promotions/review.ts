import { promotionRefundRequestInput, reviewCampaignInput, staffEndCampaignInput } from '@thrift/contracts';
import { DomainError, formatNaira, formatWat } from '@thrift/domain';
import { many, maybeOne, one, withTransaction } from '@thrift/database';
import { recordAudit } from '../core/audit';
import { requireStaff } from '../core/authz';
import type { AppContext } from '../core/context';
import { parseInput } from '../core/validation';
import { createPromotionRefund } from '../payments/refunds';
import { lockCampaign, notifyShopOwner, PLACEMENT_LABEL, unusedPortion, type CampaignRow } from './shared';

export interface StaffPromotionRow {
  id: string;
  status: CampaignRow['status'];
  shopName: string;
  shopSlug: string;
  packageName: string;
  placementLabel: string;
  targetKind: 'listing' | 'shop';
  listingId: string | null;
  listingTitle: string | null;
  listingStatus: string | null;
  priceMinor: number;
  refundMinor: number;
  refundOpenMinor: number;
  paidAt: string | null;
  startsAt: string | null;
  endsAt: string | null;
  endedAt: string | null;
  reviewReason: string | null;
  endReason: string | null;
  unusedMinor: number;
}

const QUEUE_STATUSES = { review: ['pending_review'], live: ['scheduled', 'active'], ended: ['ended', 'rejected', 'cancelled'] } as const;
export type StaffPromotionFilter = keyof typeof QUEUE_STATUSES;

/** Trust & safety queue: paid promotions waiting for review (oldest payment first), live ones, and closed ones. */
export async function staffPromotionQueue(ctx: AppContext, filter: StaffPromotionFilter = 'review'): Promise<StaffPromotionRow[]> {
  // Support can see the queue to raise unused-time refund requests; only trust & safety/admin decide or stop.
  requireStaff(ctx, 'support', 'trust_safety', 'finance', 'admin');
  const statuses = QUEUE_STATUSES[filter] ?? QUEUE_STATUSES.review;
  const rows = await many<CampaignRow & { shop_name: string; shop_slug: string; package_name: string; listing_title: string | null; listing_status: string | null; refund_open: number }>(
    ctx.pool,
    `SELECT c.*, s.name AS shop_name, s.slug AS shop_slug, p.name AS package_name, l.title AS listing_title, l.status AS listing_status,
            coalesce((SELECT sum(r.amount_minor) FROM refunds r WHERE r.ad_campaign_id = c.id AND r.status IN ('requested','approved','processing')), 0)::bigint AS refund_open
       FROM ad_campaigns c JOIN shops s ON s.id = c.shop_id JOIN ad_packages p ON p.id = c.package_id LEFT JOIN listings l ON l.id = c.listing_id
      WHERE c.status = ANY($1::text[])
      ORDER BY ${filter === 'review' ? 'c.paid_at ASC' : 'c.updated_at DESC'} LIMIT 100`,
    [statuses],
  );
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    shopName: r.shop_name,
    shopSlug: r.shop_slug,
    packageName: r.package_name,
    placementLabel: PLACEMENT_LABEL[r.placement],
    targetKind: r.target_kind,
    listingId: r.listing_id,
    listingTitle: r.listing_title,
    listingStatus: r.listing_status,
    priceMinor: Number(r.price_minor),
    refundMinor: Number(r.refund_minor),
    refundOpenMinor: Number(r.refund_open),
    paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null,
    startsAt: r.starts_at ? new Date(r.starts_at).toISOString() : null,
    endsAt: r.ends_at ? new Date(r.ends_at).toISOString() : null,
    endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : null,
    reviewReason: r.review_reason,
    endReason: r.end_reason,
    unusedMinor: unusedPortion(r).unusedMinor,
  }));
}

/**
 * Approve: the promotion goes live now for the package's duration (the target must still be eligible).
 * Reject: the seller gets the reason and a full automatic refund — nothing was delivered.
 */
export async function reviewPromotion(ctx: AppContext, raw: unknown): Promise<{ status: 'active' | 'rejected' }> {
  const staff = requireStaff(ctx, 'trust_safety', 'admin');
  const input = parseInput(reviewCampaignInput, raw);
  return withTransaction(ctx.pool, async (tx) => {
    const c = await lockCampaign(tx, input.campaignId);
    if (c.status !== 'pending_review') throw new DomainError('INVALID_STATE', 'This promotion isn’t waiting for review.');
    if (input.decision === 'approve') {
      if (c.target_kind === 'listing') {
        const l = await one<{ status: string; available: number }>(
          tx,
          `SELECT l.status, coalesce(st.quantity_available, 0)::int AS available FROM listings l LEFT JOIN inventory_stock st ON st.listing_id = l.id WHERE l.id = $1`,
          [c.listing_id],
        );
        if (!['active', 'reserved'].includes(l.status)) throw new DomainError('INVALID_STATE', 'The item is no longer for sale. Reject the promotion so the seller is refunded.');
      }
      const shop = await one<{ status: string }>(tx, 'SELECT status FROM shops WHERE id = $1', [c.shop_id]);
      if (shop.status === 'suspended') throw new DomainError('INVALID_STATE', 'The shop is suspended. Reject the promotion so the seller is refunded.');
      const pkg = await one<{ duration_days: number }>(tx, 'SELECT duration_days FROM ad_packages WHERE id = $1', [c.package_id]);
      const startsAt = ctx.now();
      const endsAt = new Date(startsAt.getTime() + pkg.duration_days * 86_400_000);
      await tx.query(
        `UPDATE ad_campaigns SET status = 'active', starts_at = $2, ends_at = $3, reviewed_by = $4, reviewed_at = $2, review_reason = $5, updated_at = now() WHERE id = $1`,
        [c.id, startsAt, endsAt, staff.userId, input.reason],
      );
      await notifyShopOwner(tx, c.shop_id, {
        kind: 'promotion_live',
        title: 'Your promotion is live',
        body: `${PLACEMENT_LABEL[c.placement]} placement until ${formatWat(endsAt)}. It’s labelled “Sponsored” and doesn’t change your reputation or badges.`,
        dedupeKey: `promotion-live:${c.id}`,
      });
    } else {
      await tx.query(`UPDATE ad_campaigns SET status = 'rejected', reviewed_by = $2, reviewed_at = $3, review_reason = $4, updated_at = now() WHERE id = $1`, [
        c.id,
        staff.userId,
        ctx.now(),
        input.reason,
      ]);
      await createPromotionRefund(tx, ctx, {
        campaignId: c.id,
        amountMinor: c.price_minor,
        reason: 'promotion_rejected',
        note: input.reason,
        requestedBy: staff.userId,
        autoApprove: true,
        idempotencyKey: `promotion-reject:${c.id}`,
      });
      await notifyShopOwner(tx, c.shop_id, {
        kind: 'promotion_rejected',
        title: 'Your promotion wasn’t approved',
        body: `Reason: ${input.reason} You’ll get a full refund of ${formatNaira(c.price_minor)}.`,
        dedupeKey: `promotion-rejected:${c.id}`,
      });
    }
    await recordAudit(tx, ctx, { action: `promotion.${input.decision === 'approve' ? 'approved' : 'rejected'}`, targetKind: 'ad_campaign', targetId: c.id, reason: input.reason });
    return { status: input.decision === 'approve' ? ('active' as const) : ('rejected' as const) };
  });
}

/** Staff stop a live promotion (e.g. a problem found after approval). Refunds for unused time are a separate request. */
export async function staffEndPromotion(ctx: AppContext, raw: unknown): Promise<{ status: 'ended' }> {
  requireStaff(ctx, 'trust_safety', 'admin');
  const input = parseInput(staffEndCampaignInput, raw);
  return withTransaction(ctx.pool, async (tx) => {
    const c = await lockCampaign(tx, input.campaignId);
    if (!['scheduled', 'active', 'paused'].includes(c.status)) throw new DomainError('INVALID_STATE', 'Only a live promotion can be stopped.');
    await tx.query(`UPDATE ad_campaigns SET status = 'ended', ended_at = $2, end_reason = $3, updated_at = now() WHERE id = $1`, [c.id, ctx.now(), `staff: ${input.reason}`]);
    await notifyShopOwner(tx, c.shop_id, {
      kind: 'promotion_stopped',
      title: 'Your promotion was stopped',
      body: `Reason: ${input.reason} Contact support if you have questions about the unused time.`,
      dedupeKey: `promotion-stopped:${c.id}`,
    });
    await recordAudit(tx, ctx, { action: 'promotion.ended_by_staff', targetKind: 'ad_campaign', targetId: c.id, reason: input.reason });
    return { status: 'ended' as const };
  });
}

/**
 * Staff request a refund for an early-ended promotion's unused time. The amount is a judgement (no automatic
 * policy yet — D10), capped at what is still refundable, and a different finance/admin member must approve it.
 */
export async function requestPromotionRefund(ctx: AppContext, raw: unknown): Promise<{ refundId: string; status: string }> {
  const staff = requireStaff(ctx, 'support', 'trust_safety', 'finance', 'admin');
  const input = parseInput(promotionRefundRequestInput, raw);
  return withTransaction(ctx.pool, async (tx) => {
    const c = await lockCampaign(tx, input.campaignId);
    if (c.status !== 'ended' || !c.ended_at || !c.ends_at || new Date(c.ended_at) >= new Date(c.ends_at)) {
      throw new DomainError('INVALID_STATE', 'Only a promotion that stopped before its scheduled end can get an unused-time refund.');
    }
    const open = await maybeOne(tx, `SELECT 1 AS ok FROM refunds WHERE ad_campaign_id = $1 AND reason = 'promotion_ended_early' AND status IN ('requested','approved','processing')`, [c.id]);
    if (open) throw new DomainError('CONFLICT', 'A refund for this promotion is already waiting for a decision.');
    const refund = await createPromotionRefund(tx, ctx, {
      campaignId: c.id,
      amountMinor: input.amount,
      reason: 'promotion_ended_early',
      note: input.note,
      requestedBy: staff.userId,
      autoApprove: false,
      idempotencyKey: `promotion-early:${c.id}:${input.amount}:${staff.userId}:${ctx.now().getTime()}`,
    });
    return { refundId: refund.id, status: refund.status };
  });
}
