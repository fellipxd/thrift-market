import { campaignIdInput, createCampaignInput } from '@thrift/contracts';
import { DomainError, formatNaira } from '@thrift/domain';
import { isUniqueViolation, many, maybeOne, one, withTransaction } from '@thrift/database';
import type { VerifyPaymentResult } from '@thrift/providers';
import { recordAudit } from '../core/audit';
import { assertShopCanSell, assertShopMember, requireOwnShop, requireVerifiedUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { parseInput } from '../core/validation';
import { postLedgerTransaction } from '../ledger/ledger';
import { createPaymentAttempt, initializePaymentAttempt, type PaymentAttemptRow } from '../payments/attempts';
import type { ApplyResult } from '../payments/apply';
import { createPromotionRefund } from '../payments/refunds';
import { lockCampaign, notifyShopOwner, PLACEMENT_LABEL, type CampaignRow } from './shared';

export const PROMOTION_RETURN_PATH = '/sell/promotions/return';

interface PackageRow {
  id: string;
  name: string;
  target_kind: 'listing' | 'shop';
  placement: CampaignRow['placement'];
  duration_days: number;
  price_minor: number;
  active: boolean;
  [k: string]: unknown;
}

export interface PromotionPaymentStart {
  campaignId: string;
  authorizationUrl: string | null;
  paymentStatus: 'pending' | 'uncertain';
}

/**
 * Seller books a promotion package for one of their available listings (or their shop) and is sent to pay.
 * The price is copied from the package at booking time. Nothing is shown to shoppers until the payment is
 * provider-confirmed and trust & safety approves it.
 */
export async function bookPromotion(ctx: AppContext, raw: unknown): Promise<PromotionPaymentStart> {
  const user = requireVerifiedUser(ctx);
  const input = parseInput(createCampaignInput, raw);
  const shop = await requireOwnShop(ctx.pool, ctx);
  assertShopCanSell(shop);
  const pkg = await maybeOne<PackageRow>(ctx.pool, 'SELECT * FROM ad_packages WHERE id = $1 AND active', [input.packageId]);
  if (!pkg) throw new DomainError('NOT_FOUND', 'That promotion package isn’t available.');
  if (pkg.target_kind === 'listing') {
    if (!input.listingId) throw new DomainError('VALIDATION_FAILED', 'Choose the item to promote.', { fieldErrors: { listingId: 'Choose an item.' } });
    const l = await maybeOne<{ status: string; available: number }>(
      ctx.pool,
      `SELECT l.status, coalesce(st.quantity_available, 0)::int AS available FROM listings l LEFT JOIN inventory_stock st ON st.listing_id = l.id
        WHERE l.id = $1 AND l.shop_id = $2`,
      [input.listingId, shop.id],
    );
    if (!l) throw new DomainError('NOT_FOUND', 'Item not found.');
    if (l.status !== 'active' || l.available <= 0) throw new DomainError('INVALID_STATE', 'Only published items that are in stock can be promoted.');
  } else if (input.listingId) {
    throw new DomainError('VALIDATION_FAILED', 'This package promotes your whole shop, not a single item.');
  }
  let created: { campaignId: string; attemptId: string };
  try {
    created = await withTransaction(ctx.pool, async (tx) => {
      const c = await one<{ id: string }>(
        tx,
        `INSERT INTO ad_campaigns (shop_id, package_id, target_kind, listing_id, placement, price_minor, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [shop.id, pkg.id, pkg.target_kind, pkg.target_kind === 'listing' ? input.listingId : null, pkg.placement, pkg.price_minor, user.userId],
      );
      const attempt = await createPaymentAttempt(tx, ctx, { adCampaignId: c.id, payerUserId: user.userId, amountMinor: pkg.price_minor });
      await recordAudit(tx, ctx, { action: 'promotion.booked', targetKind: 'ad_campaign', targetId: c.id, data: { packageId: pkg.id, priceMinor: pkg.price_minor } });
      return { campaignId: c.id, attemptId: attempt.id };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new DomainError('CONFLICT', `There’s already a ${PLACEMENT_LABEL[pkg.placement].toLowerCase()} promotion booked for this ${pkg.target_kind === 'listing' ? 'item' : 'shop'}. Pay for it or cancel it first.`);
    }
    throw err;
  }
  const init = await initializePaymentAttempt(ctx, created.attemptId, { callbackPath: PROMOTION_RETURN_PATH, description: `Promotion · ${pkg.name}` });
  return { campaignId: created.campaignId, authorizationUrl: init.authorizationUrl, paymentStatus: init.status };
}

/** Resumes payment for a booking that is still waiting for it (reuses an open provider attempt). */
export async function payForPromotion(ctx: AppContext, raw: unknown): Promise<PromotionPaymentStart> {
  const user = requireVerifiedUser(ctx);
  const { campaignId } = parseInput(campaignIdInput, raw);
  const c = await maybeOne<CampaignRow>(ctx.pool, 'SELECT * FROM ad_campaigns WHERE id = $1', [campaignId]);
  if (!c) throw new DomainError('NOT_FOUND', 'Promotion not found.');
  await assertShopMember(ctx.pool, ctx, c.shop_id);
  if (c.status !== 'awaiting_payment') throw new DomainError('INVALID_STATE', 'This promotion isn’t waiting for payment.');
  const open = await maybeOne<{ authorization_url: string | null; status: string }>(
    ctx.pool,
    `SELECT authorization_url, status FROM payment_attempts WHERE ad_campaign_id = $1 AND status IN ('initiated','pending','uncertain') ORDER BY created_at DESC LIMIT 1`,
    [c.id],
  );
  if (open && open.status !== 'initiated') {
    return { campaignId: c.id, authorizationUrl: open.authorization_url, paymentStatus: open.status === 'pending' ? 'pending' : 'uncertain' };
  }
  const attemptId = await withTransaction(ctx.pool, async (tx) => {
    const locked = await lockCampaign(tx, c.id);
    if (locked.status !== 'awaiting_payment') throw new DomainError('INVALID_STATE', 'This promotion isn’t waiting for payment.');
    const pending = await maybeOne<{ id: string }>(tx, `SELECT id FROM payment_attempts WHERE ad_campaign_id = $1 AND status IN ('initiated','pending','uncertain') LIMIT 1`, [c.id]);
    if (pending) return pending.id;
    return (await createPaymentAttempt(tx, ctx, { adCampaignId: c.id, payerUserId: user.userId, amountMinor: locked.price_minor })).id;
  });
  const init = await initializePaymentAttempt(ctx, attemptId, { callbackPath: PROMOTION_RETURN_PATH, description: 'Promotion' });
  return { campaignId: c.id, authorizationUrl: init.authorizationUrl, paymentStatus: init.status };
}

/**
 * Seller cancels a promotion that hasn't gone live. Unpaid: the booking just closes. Paid and waiting for review:
 * the full price is refunded automatically (nothing was delivered). A running promotion can't be cancelled here —
 * refunds for unused time are an owner policy decision (D10), so support handles those case by case.
 */
export async function cancelPromotion(ctx: AppContext, raw: unknown): Promise<{ status: 'cancelled'; refundMinor: number }> {
  requireVerifiedUser(ctx);
  const { campaignId } = parseInput(campaignIdInput, raw);
  const peek = await maybeOne<{ shop_id: string }>(ctx.pool, 'SELECT shop_id FROM ad_campaigns WHERE id = $1', [campaignId]);
  if (!peek) throw new DomainError('NOT_FOUND', 'Promotion not found.');
  const user = await assertShopMember(ctx.pool, ctx, peek.shop_id);
  return withTransaction(ctx.pool, async (tx) => {
    const c = await lockCampaign(tx, campaignId);
    if (c.status === 'cancelled') return { status: 'cancelled' as const, refundMinor: 0 };
    if (!['awaiting_payment', 'pending_review', 'scheduled'].includes(c.status)) {
      throw new DomainError('INVALID_STATE', 'A promotion that is live or finished can’t be cancelled here. Contact support if something is wrong.');
    }
    let refundMinor = 0;
    if (c.status !== 'awaiting_payment') {
      await createPromotionRefund(tx, ctx, {
        campaignId: c.id,
        amountMinor: c.price_minor,
        reason: 'promotion_cancelled',
        note: 'Cancelled by the seller before going live.',
        requestedBy: user.userId,
        autoApprove: true,
        idempotencyKey: `promotion-cancel:${c.id}`,
      });
      refundMinor = c.price_minor;
    }
    await tx.query(`UPDATE ad_campaigns SET status = 'cancelled', end_reason = 'cancelled_by_seller', updated_at = now() WHERE id = $1`, [c.id]);
    await recordAudit(tx, ctx, { action: 'promotion.cancelled', targetKind: 'ad_campaign', targetId: c.id, data: { from: c.status, refundMinor } });
    return { status: 'cancelled' as const, refundMinor };
  });
}

/**
 * Payment purpose handler for promotions (registered with the payments module). Runs after the provider has
 * verified the reference. Applies the result exactly once: the money is recorded as ad revenue and the booking
 * moves to review; a payment for a booking that already lapsed or was cancelled is refunded automatically, and a
 * second payment for the same booking is parked and refunded as a duplicate.
 */
export async function applyPromotionPayment(ctx: AppContext, attempt: PaymentAttemptRow, verified: VerifyPaymentResult): Promise<ApplyResult> {
  const campaignId = attempt.ad_campaign_id!;
  const base = { orderId: null, adCampaignId: campaignId };
  if (verified.status === 'pending' || verified.status === 'not_found') return { outcome: 'pending', ...base };
  if (verified.status === 'failed' || verified.status === 'abandoned') {
    await ctx.pool.query(
      `UPDATE payment_attempts SET status = $2, failure_reason = coalesce(failure_reason, $3), updated_at = now() WHERE id = $1 AND status IN ('initiated','pending','uncertain')`,
      [attempt.id, verified.status, `provider reported ${verified.status}`],
    );
    return { outcome: 'failed', ...base };
  }
  if (verified.amountMinor !== attempt.amount_minor || (verified.currency ?? 'NGN') !== attempt.currency) {
    await withTransaction(ctx.pool, async (tx) => {
      await tx.query(`UPDATE payment_attempts SET status = 'uncertain', failure_reason = $2, updated_at = now() WHERE id = $1 AND status NOT IN ('succeeded','duplicate')`, [
        attempt.id,
        `amount mismatch: provider ${verified.amountMinor} ${verified.currency}, expected ${attempt.amount_minor} ${attempt.currency}`,
      ]);
      await recordAudit(tx, ctx, {
        action: 'payment.amount_mismatch',
        targetKind: 'payment_attempt',
        targetId: attempt.id,
        data: { reference: attempt.reference, expected: attempt.amount_minor, received: verified.amountMinor, currency: verified.currency },
      });
    });
    return { outcome: 'mismatch', ...base };
  }
  return withTransaction(ctx.pool, async (tx) => {
    const c = await lockCampaign(tx, campaignId);
    const a = await one<PaymentAttemptRow>(tx, 'SELECT * FROM payment_attempts WHERE id = $1 FOR UPDATE', [attempt.id]);
    if (a.status === 'succeeded' || a.status === 'duplicate') return { outcome: 'already_applied' as const, ...base };
    const paidAt = verified.paidAt ?? ctx.now();
    const otherSuccess = await maybeOne(tx, `SELECT 1 AS ok FROM payment_attempts WHERE ad_campaign_id = $1 AND status = 'succeeded' AND id <> $2`, [c.id, a.id]);
    if (otherSuccess) {
      await tx.query(`UPDATE payment_attempts SET status = 'duplicate', succeeded_at = $2, provider_transaction_id = $3, updated_at = now() WHERE id = $1`, [a.id, paidAt, verified.providerTransactionId]);
      await postLedgerTransaction(tx, {
        kind: 'ad_payment',
        description: 'Duplicate promotion payment (to refund)',
        idempotencyKey: `ad-payment:${a.id}`,
        lines: [
          { account: 'provider_clearing', amountMinor: a.amount_minor },
          { account: 'refunds_payable', amountMinor: -a.amount_minor },
        ],
      });
      await createPromotionRefund(tx, ctx, {
        campaignId: c.id,
        paymentAttemptId: a.id,
        amountMinor: a.amount_minor,
        reason: 'duplicate_payment',
        note: 'Second successful payment for an already-paid promotion.',
        autoApprove: true,
        idempotencyKey: `promotion-duplicate:${a.id}`,
      });
      return { outcome: 'duplicate_refunded' as const, ...base };
    }
    await tx.query(`UPDATE payment_attempts SET status = 'succeeded', succeeded_at = $2, provider_transaction_id = $3, updated_at = now() WHERE id = $1`, [a.id, paidAt, verified.providerTransactionId]);
    await postLedgerTransaction(tx, {
      kind: 'ad_payment',
      description: 'Promotion payment',
      idempotencyKey: `ad-payment:${a.id}`,
      lines: [
        { account: 'provider_clearing', amountMinor: a.amount_minor },
        { account: 'ad_revenue', amountMinor: -a.amount_minor, shopId: c.shop_id },
      ],
    });
    if (c.status !== 'awaiting_payment') {
      // The booking lapsed or was cancelled before the money arrived: nothing will be delivered, so refund it all.
      await tx.query('UPDATE ad_campaigns SET paid_at = coalesce(paid_at, $2), updated_at = now() WHERE id = $1', [c.id, paidAt]);
      await createPromotionRefund(tx, ctx, {
        campaignId: c.id,
        paymentAttemptId: a.id,
        amountMinor: a.amount_minor,
        reason: 'promotion_cancelled',
        note: 'Payment arrived after the booking had closed.',
        autoApprove: true,
        idempotencyKey: `promotion-late:${a.id}`,
      });
      await notifyShopOwner(tx, c.shop_id, {
        kind: 'promotion_payment_refunded',
        title: 'Your promotion payment is being refunded',
        body: `The booking had already closed when your payment of ${formatNaira(a.amount_minor)} arrived, so we’re refunding it in full.`,
        dedupeKey: `promotion-late:${a.id}`,
      });
      return { outcome: 'late_refunded' as const, ...base };
    }
    await tx.query(`UPDATE ad_campaigns SET status = 'pending_review', paid_at = $2, updated_at = now() WHERE id = $1`, [c.id, paidAt]);
    await recordAudit(tx, ctx, { action: 'promotion.paid', targetKind: 'ad_campaign', targetId: c.id, data: { attemptId: a.id, amountMinor: a.amount_minor } });
    await notifyShopOwner(tx, c.shop_id, {
      kind: 'promotion_paid',
      title: 'Promotion payment received',
      body: 'Our team reviews promotions before they go live. If it isn’t approved, you get a full refund.',
      dedupeKey: `promotion-paid:${c.id}`,
    });
    return { outcome: 'paid' as const, ...base };
  });
}

/** Packages a seller can book now, and their items that are eligible for listing packages. */
export async function promotionOptions(ctx: AppContext): Promise<{
  packages: { id: string; name: string; targetKind: 'listing' | 'shop'; placement: CampaignRow['placement']; placementLabel: string; durationDays: number; priceMinor: number }[];
  /** Published in-stock items, with the placements they already have an open booking for (not offered again). */
  listings: { id: string; title: string; bookedPlacements: CampaignRow['placement'][] }[];
}> {
  const shop = await requireOwnShop(ctx.pool, ctx);
  const [packages, listings] = await Promise.all([
    many<PackageRow>(ctx.pool, 'SELECT * FROM ad_packages WHERE active ORDER BY target_kind, price_minor'),
    many<{ id: string; title: string; booked_placements: CampaignRow['placement'][] }>(
      ctx.pool,
      `SELECT l.id, l.title,
              coalesce((SELECT array_agg(c.placement) FROM ad_campaigns c WHERE c.listing_id = l.id
                          AND c.status IN ('awaiting_payment','pending_review','scheduled','active','paused')), '{}') AS booked_placements
         FROM listings l JOIN inventory_stock st ON st.listing_id = l.id
        WHERE l.shop_id = $1 AND l.status = 'active' AND st.quantity_available > 0
        ORDER BY coalesce(l.published_at, l.created_at) DESC LIMIT 200`,
      [shop.id],
    ),
  ]);
  return {
    packages: packages.map((p) => ({
      id: p.id,
      name: p.name,
      targetKind: p.target_kind,
      placement: p.placement,
      placementLabel: PLACEMENT_LABEL[p.placement],
      durationDays: p.duration_days,
      priceMinor: Number(p.price_minor),
    })),
    listings: listings.map((l) => ({ id: l.id, title: l.title, bookedPlacements: l.booked_placements })),
  };
}
