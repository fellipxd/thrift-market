import { refundDecisionInput, staffRefundInput, type RefundReason } from '@thrift/contracts';
import { DomainError } from '@thrift/domain';
import { many, maybeOne, one, withTransaction, type Queryable } from '@thrift/database';
import { recordAudit } from '../core/audit';
import { assertNotPartyToOrder, requireStaff } from '../core/authz';
import type { AppContext } from '../core/context';
import { enqueue } from '../core/outbox';
import { parseInput } from '../core/validation';
import { postLedgerTransaction, type LedgerLine } from '../ledger/ledger';
import { notifyUser } from '../notifications/notify';

export interface RefundRow {
  id: string;
  /** Exactly one of order_id / ad_campaign_id is set. */
  order_id: string | null;
  ad_campaign_id: string | null;
  payment_attempt_id: string;
  amount_minor: number;
  reason: RefundReason;
  status: 'requested' | 'approved' | 'processing' | 'succeeded' | 'failed' | 'rejected';
  requested_by: string | null;
  approved_by: string | null;
  allocation: RefundAllocation | null;
  provider_reference: string | null;
  attempts: number;
  [k: string]: unknown;
}

/** How a refund comes out of each ledger account (sums to the refund amount). */
export interface RefundAllocation {
  sellerMinor: number;
  commissionMinor: number;
  feesMinor: number;
  courierMinor: number;
}

/** Refund reasons that pay back money held in refunds_payable (it was never owed to the seller). */
const BUYER_OWED_REASONS: ReadonlySet<RefundReason> = new Set(['late_payment_after_release', 'duplicate_payment']);
/** Refunds a staff member requests by judgement: a different finance/admin member must approve (four-eyes). */
const FOUR_EYES_REASONS: ReadonlySet<RefundReason> = new Set(['staff_exception', 'promotion_ended_early']);

/**
 * Creates a refund inside the caller's transaction (call after locking the order). Validates the amount against
 * what was paid on that attempt minus refunds already in flight or done, and is idempotent on idempotencyKey.
 * Staff exceptions start as 'requested' and need a different finance user to approve (four-eyes).
 * The provider is called later by the refund worker — a refund is not complete until the provider confirms it.
 */
export async function createRefund(
  tx: Queryable,
  ctx: AppContext,
  args: {
    orderId: string;
    paymentAttemptId?: string | null;
    amountMinor: number;
    reason: RefundReason;
    note?: string | null;
    requestedBy?: string | null;
    autoApprove: boolean;
    idempotencyKey: string;
    /** Exact ledger split (e.g. from order items' frozen shares); must sum to amountMinor. */
    allocation?: RefundAllocation | null;
  },
): Promise<RefundRow> {
  const existing = await maybeOne<RefundRow>(tx, 'SELECT * FROM refunds WHERE idempotency_key = $1', [args.idempotencyKey]);
  if (existing) return existing;
  if (!Number.isSafeInteger(args.amountMinor) || args.amountMinor <= 0) throw new DomainError('VALIDATION_FAILED', 'Refund amount must be positive.');
  if (args.allocation) {
    const a = args.allocation;
    const parts = [a.sellerMinor, a.commissionMinor, a.feesMinor, a.courierMinor];
    if (parts.some((x) => !Number.isSafeInteger(x) || x < 0) || parts.reduce((x, y) => x + y, 0) !== args.amountMinor) {
      throw new DomainError('VALIDATION_FAILED', 'Refund allocation must be non-negative and add up to the refund amount.');
    }
  }
  const attempt = args.paymentAttemptId
    ? await maybeOne<{ id: string; amount_minor: number; status: string }>(tx, 'SELECT id, amount_minor, status FROM payment_attempts WHERE id = $1 AND order_id = $2', [
        args.paymentAttemptId,
        args.orderId,
      ])
    : await maybeOne<{ id: string; amount_minor: number; status: string }>(
        tx,
        `SELECT id, amount_minor, status FROM payment_attempts WHERE order_id = $1 AND status = 'succeeded'`,
        [args.orderId],
      );
  if (!attempt || !['succeeded', 'duplicate'].includes(attempt.status)) {
    throw new DomainError('INVALID_STATE', 'There is no confirmed payment to refund on this order.');
  }
  const already = await one<{ s: number }>(
    tx,
    `SELECT coalesce(sum(amount_minor), 0)::bigint AS s FROM refunds WHERE payment_attempt_id = $1 AND status NOT IN ('rejected','failed')`,
    [attempt.id],
  );
  if (args.amountMinor > attempt.amount_minor - already.s) {
    throw new DomainError('VALIDATION_FAILED', 'The refund is more than the amount still refundable on this payment.', {
      refundableMinor: attempt.amount_minor - already.s,
    });
  }
  const status = args.autoApprove && !FOUR_EYES_REASONS.has(args.reason) ? 'approved' : 'requested';
  const refund = await one<RefundRow>(
    tx,
    `INSERT INTO refunds (order_id, payment_attempt_id, amount_minor, reason, note, status, requested_by, approved_by, idempotency_key, allocation)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9) RETURNING *`,
    [args.orderId, attempt.id, args.amountMinor, args.reason, args.note ?? null, status, args.requestedBy ?? null, args.idempotencyKey, args.allocation ? JSON.stringify(args.allocation) : null],
  );
  if (!BUYER_OWED_REASONS.has(args.reason)) {
    await tx.query(
      `UPDATE orders SET payment_status = 'refund_pending', updated_at = now() WHERE id = $1 AND payment_status IN ('paid','partially_refunded')`,
      [args.orderId],
    );
  }
  await tx.query(`INSERT INTO order_events (order_id, kind, actor_kind, actor_user_id, data) VALUES ($1, 'refund_created', $2, $3, $4)`, [
    args.orderId,
    ctx.actor.kind === 'user' ? (ctx.actor.roles.length ? 'staff' : 'buyer') : 'system',
    ctx.actor.kind === 'user' ? ctx.actor.userId : null,
    JSON.stringify({ refundId: refund.id, amountMinor: args.amountMinor, reason: args.reason, status }),
  ]);
  await recordAudit(tx, ctx, { action: 'refund.created', targetKind: 'refund', targetId: refund.id, data: { orderId: args.orderId, amountMinor: args.amountMinor, reason: args.reason, status } });
  if (status === 'approved') await enqueue(tx, { topic: 'refund.approved', aggregateId: refund.id, dedupeKey: `refund.approved:${refund.id}` });
  return refund;
}

/**
 * Support/finance raise an exception refund on a paid order (goodwill, a problem outside the dispute rules). It
 * waits for a different finance/admin team member to approve it; staff who bought or sold the order can't raise it.
 */
export async function requestStaffRefund(ctx: AppContext, raw: unknown): Promise<{ refundId: string; orderId: string; status: string }> {
  const staff = requireStaff(ctx, 'support', 'finance', 'admin');
  const input = parseInput(staffRefundInput, raw);
  return withTransaction(ctx.pool, async (tx) => {
    const o = await maybeOne<{ id: string; status: string }>(tx, 'SELECT id, status FROM orders WHERE number = $1 FOR UPDATE', [input.orderNumber]);
    if (!o) throw new DomainError('NOT_FOUND', 'No order has that number.', { fieldErrors: { orderNumber: 'Not found' } });
    await assertNotPartyToOrder(tx, staff.userId, o.id);
    const refund = await createRefund(tx, ctx, {
      orderId: o.id,
      amountMinor: input.amount,
      reason: 'staff_exception',
      note: input.note,
      requestedBy: staff.userId,
      autoApprove: false,
      idempotencyKey: `staff-exception:${o.id}:${input.amount}:${staff.userId}:${ctx.now().getTime()}`,
    });
    return { refundId: refund.id, orderId: o.id, status: refund.status };
  });
}

/** Finance decision on a requested refund. Staff-exception refunds must be approved by someone other than the requester. */
export async function decideRefund(ctx: AppContext, raw: unknown): Promise<{ refundId: string; status: string }> {
  const staff = requireStaff(ctx, 'finance', 'admin');
  const input = parseInput(refundDecisionInput, raw);
  return withTransaction(ctx.pool, async (tx) => {
    const r = await maybeOne<RefundRow>(tx, 'SELECT * FROM refunds WHERE id = $1 FOR UPDATE', [input.refundId]);
    if (!r) throw new DomainError('NOT_FOUND', 'Refund not found.');
    if (r.status !== 'requested') throw new DomainError('INVALID_STATE', 'This refund has already been decided.');
    if (input.decision === 'approve') {
      if (FOUR_EYES_REASONS.has(r.reason) && r.requested_by === staff.userId) {
        throw new DomainError('FORBIDDEN', 'A different finance team member must approve an exception you requested.');
      }
      if (r.order_id) await assertNotPartyToOrder(tx, staff.userId, r.order_id);
      await tx.query(`UPDATE refunds SET status = 'approved', approved_by = $2, updated_at = now() WHERE id = $1`, [r.id, staff.userId]);
      await enqueue(tx, { topic: 'refund.approved', aggregateId: r.id, dedupeKey: `refund.approved:${r.id}` });
    } else {
      await tx.query(`UPDATE refunds SET status = 'rejected', approved_by = $2, note = coalesce(note, '') || $3, updated_at = now() WHERE id = $1`, [
        r.id,
        staff.userId,
        ` [rejected: ${input.reason}]`,
      ]);
      const open = r.order_id
        ? await one<{ n: number }>(tx, `SELECT count(*)::int AS n FROM refunds WHERE order_id = $1 AND status IN ('requested','approved','processing')`, [r.order_id])
        : { n: -1 };
      if (open.n === 0) {
        await tx.query(
          `UPDATE orders SET payment_status = CASE WHEN EXISTS (SELECT 1 FROM refunds WHERE order_id = $1 AND status = 'succeeded') THEN 'partially_refunded' ELSE 'paid' END,
                  updated_at = now() WHERE id = $1 AND payment_status = 'refund_pending'`,
          [r.order_id],
        );
      }
    }
    await recordAudit(tx, ctx, { action: `refund.${input.decision === 'approve' ? 'approved' : 'rejected'}`, targetKind: 'refund', targetId: r.id, reason: input.reason });
    return { refundId: r.id, status: input.decision === 'approve' ? 'approved' : 'rejected' };
  });
}

/** Ledger lines for a confirmed refund (see ADR-0002 and docs/architecture). */
async function refundLedgerLines(tx: Queryable, r: RefundRow): Promise<{ lines: LedgerLine[]; payoutAdjust: { cancel: boolean; reduceBy: number } }> {
  if (BUYER_OWED_REASONS.has(r.reason)) {
    return { lines: [{ account: 'refunds_payable', amountMinor: r.amount_minor }, { account: 'provider_clearing', amountMinor: -r.amount_minor }], payoutAdjust: { cancel: false, reduceBy: 0 } };
  }
  const o = await one<{ shop_id: string; total_minor: number; shipping_minor: number; buyer_fee_minor: number; commission_minor: number; delivery_method: string }>(
    tx,
    'SELECT shop_id, total_minor, shipping_minor, buyer_fee_minor, commission_minor, delivery_method FROM orders WHERE id = $1',
    [r.order_id],
  );
  const payout = await maybeOne<{ id: string; status: string; amount_minor: number }>(tx, 'SELECT id, status, amount_minor FROM payouts WHERE order_id = $1 FOR UPDATE', [r.order_id]);
  const priorRefunds = await one<{ s: number }>(
    tx,
    `SELECT coalesce(sum(amount_minor), 0)::bigint AS s FROM refunds WHERE order_id = $1 AND status = 'succeeded' AND id <> $2 AND reason NOT IN ('late_payment_after_release','duplicate_payment')`,
    [r.order_id, r.id],
  );
  const credit: LedgerLine = { account: 'provider_clearing', amountMinor: -r.amount_minor };
  if (payout && (payout.status === 'paid' || payout.status === 'processing')) {
    // Seller already paid: the platform funds the refund and finance follows up (never a fictional balance).
    return { lines: [{ account: 'suspense', amountMinor: r.amount_minor }, credit], payoutAdjust: { cancel: false, reduceBy: 0 } };
  }
  if (r.allocation) {
    // Exact split frozen at request time (per-item refunds): each account gives back what it received.
    const a = r.allocation;
    return {
      lines: [
        { account: 'seller_payable', amountMinor: a.sellerMinor, shopId: o.shop_id },
        { account: 'platform_commission', amountMinor: a.commissionMinor },
        { account: 'platform_fees', amountMinor: a.feesMinor },
        { account: 'courier_payable', amountMinor: a.courierMinor },
        credit,
      ],
      payoutAdjust: { cancel: false, reduceBy: a.sellerMinor },
    };
  }
  if (priorRefunds.s === 0 && r.amount_minor === o.total_minor) {
    const proceeds = payout?.amount_minor ?? 0;
    const shippingToCourier = o.delivery_method === 'integrated' ? o.shipping_minor : 0;
    const lines: LedgerLine[] = [
      { account: 'seller_payable', amountMinor: proceeds, shopId: o.shop_id },
      { account: 'platform_commission', amountMinor: o.commission_minor },
      { account: 'platform_fees', amountMinor: o.buyer_fee_minor },
      { account: 'courier_payable', amountMinor: shippingToCourier },
      credit,
    ];
    const diff = lines.reduce((s, l) => s + l.amountMinor, 0);
    if (diff !== 0) lines.push({ account: 'suspense', amountMinor: -diff });
    return { lines, payoutAdjust: { cancel: true, reduceBy: 0 } };
  }
  const sellerPortion = Math.min(r.amount_minor, payout?.amount_minor ?? 0);
  return {
    lines: [
      { account: 'seller_payable', amountMinor: sellerPortion, shopId: o.shop_id },
      { account: 'platform_fees', amountMinor: r.amount_minor - sellerPortion },
      credit,
    ],
    payoutAdjust: { cancel: false, reduceBy: sellerPortion },
  };
}

/**
 * Worker: sends approved refunds to the provider (outside transactions) and applies confirmed results.
 * Idempotent: the provider call carries the refund's idempotency key; the ledger posting has a unique key.
 */
export async function processRefunds(ctx: AppContext, batchSize = 20): Promise<{ succeeded: number; failed: number }> {
  const claimed = await withTransaction(ctx.pool, (tx) =>
    many<RefundRow & { reference: string }>(
      tx,
      `UPDATE refunds r SET status = 'processing', attempts = r.attempts + 1, updated_at = now()
         FROM payment_attempts pa
        WHERE pa.id = r.payment_attempt_id AND r.id IN (
          SELECT id FROM refunds
           WHERE status = 'approved'
              OR (status = 'failed' AND attempts < 5 AND updated_at < now() - interval '10 minutes')
              OR (status = 'processing' AND updated_at < now() - interval '15 minutes')
           ORDER BY updated_at LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING r.*, pa.reference`,
      [batchSize],
    ),
  );
  let succeeded = 0;
  let failed = 0;
  for (const r of claimed) {
    let result: { status: 'processing' | 'succeeded' | 'failed'; providerReference: string | null };
    try {
      result = await ctx.providers.payments.refund({ reference: r.reference, amountMinor: r.amount_minor, idempotencyKey: r.idempotency_key as string });
    } catch (err) {
      result = { status: 'failed', providerReference: null };
      await ctx.pool.query(`UPDATE refunds SET last_error = $2 WHERE id = $1`, [r.id, String((err as Error).message).slice(0, 500)]);
    }
    if (result.status === 'processing') {
      await ctx.pool.query(`UPDATE refunds SET provider_reference = $2, updated_at = now() WHERE id = $1`, [r.id, result.providerReference]);
      continue;
    }
    if (result.status === 'failed') {
      failed++;
      await ctx.pool.query(`UPDATE refunds SET status = 'failed', updated_at = now() WHERE id = $1 AND status = 'processing'`, [r.id]);
      continue;
    }
    await confirmRefund(ctx, r.id, result.providerReference);
    succeeded++;
  }
  return { succeeded, failed };
}

/** Applies a provider-confirmed refund exactly once (ledger + order payment state + payout adjustment). */
export async function confirmRefund(ctx: AppContext, refundId: string, providerReference: string | null): Promise<void> {
  await withTransaction(ctx.pool, async (tx) => {
    const peek = await one<{ order_id: string | null; ad_campaign_id: string | null }>(tx, 'SELECT order_id, ad_campaign_id FROM refunds WHERE id = $1', [refundId]);
    if (peek.ad_campaign_id) return confirmPromotionRefund(tx, refundId, peek.ad_campaign_id, providerReference);
    await tx.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [peek.order_id]);
    const r = await one<RefundRow>(tx, 'SELECT * FROM refunds WHERE id = $1 FOR UPDATE', [refundId]);
    if (r.status === 'succeeded') return;
    const { lines, payoutAdjust } = await refundLedgerLines(tx, r);
    await postLedgerTransaction(tx, {
      kind: BUYER_OWED_REASONS.has(r.reason) ? 'late_payment_refund' : 'refund_issued',
      orderId: r.order_id,
      description: `Refund ${r.reason.replace(/_/g, ' ')}`,
      idempotencyKey: `refund:${r.id}`,
      lines,
    });
    await tx.query(`UPDATE refunds SET status = 'succeeded', provider_reference = coalesce($2, provider_reference), confirmed_at = now(), updated_at = now() WHERE id = $1`, [
      r.id,
      providerReference,
    ]);
    if (payoutAdjust.cancel) {
      await tx.query(`UPDATE payouts SET status = 'cancelled', hold_reason = 'refunded', updated_at = now() WHERE order_id = $1 AND status IN ('held','blocked','eligible','failed')`, [r.order_id]);
      await tx.query(`UPDATE orders SET payout_status = 'reversed' WHERE id = $1 AND payout_status IN ('held','blocked','eligible')`, [r.order_id]);
    } else if (payoutAdjust.reduceBy > 0) {
      await tx.query(`UPDATE payouts SET amount_minor = greatest(amount_minor - $2, 0), updated_at = now() WHERE order_id = $1 AND status IN ('held','blocked','eligible','failed')`, [
        r.order_id,
        payoutAdjust.reduceBy,
      ]);
    }
    if (!BUYER_OWED_REASONS.has(r.reason)) {
      const totals = await one<{ paid: number; refunded: number; open: number }>(
        tx,
        `SELECT (SELECT coalesce(sum(amount_minor),0) FROM payment_attempts WHERE order_id = $1 AND status = 'succeeded')::bigint AS paid,
                (SELECT coalesce(sum(amount_minor),0) FROM refunds WHERE order_id = $1 AND status = 'succeeded' AND reason NOT IN ('late_payment_after_release','duplicate_payment'))::bigint AS refunded,
                (SELECT count(*) FROM refunds WHERE order_id = $1 AND status IN ('requested','approved','processing'))::int AS open`,
        [r.order_id],
      );
      const next = totals.refunded >= totals.paid ? 'refunded' : totals.open > 0 ? 'refund_pending' : 'partially_refunded';
      await tx.query(`UPDATE orders SET payment_status = $2, updated_at = now() WHERE id = $1`, [r.order_id, next]);
    } else {
      await tx.query(`UPDATE orders SET payment_status = 'refunded', updated_at = now() WHERE id = $1 AND status = 'cancelled' AND payment_status = 'refund_pending'`, [r.order_id]);
    }
    await tx.query(`INSERT INTO order_events (order_id, kind, actor_kind, data) VALUES ($1, 'refund_succeeded', 'provider', $2)`, [
      r.order_id,
      JSON.stringify({ refundId: r.id, amountMinor: r.amount_minor }),
    ]);
    const o = await one<{ buyer_user_id: string; number: string }>(tx, 'SELECT buyer_user_id, number FROM orders WHERE id = $1', [r.order_id]);
    await notifyUser(tx, {
      userId: o.buyer_user_id,
      topic: 'transactional',
      kind: 'refund_succeeded',
      title: `Refund confirmed for order ${o.number}`,
      body: 'The payment provider has confirmed your refund. It may take a few days to appear on your statement.',
      link: `/orders/${r.order_id}`,
      dedupeKey: `refund-succeeded:${r.id}`,
    });
  });
}

/**
 * Creates a refund of a promotion payment inside the caller's transaction (call after locking the campaign).
 * Same rules as order refunds: never more than what is still refundable on the payment, idempotent on the key,
 * judgement refunds wait for a second staff member.
 */
export async function createPromotionRefund(
  tx: Queryable,
  ctx: AppContext,
  args: { campaignId: string; paymentAttemptId?: string | null; amountMinor: number; reason: RefundReason; note?: string | null; requestedBy?: string | null; autoApprove: boolean; idempotencyKey: string },
): Promise<RefundRow> {
  const existing = await maybeOne<RefundRow>(tx, 'SELECT * FROM refunds WHERE idempotency_key = $1', [args.idempotencyKey]);
  if (existing) return existing;
  if (!Number.isSafeInteger(args.amountMinor) || args.amountMinor <= 0) throw new DomainError('VALIDATION_FAILED', 'Refund amount must be positive.');
  const attempt = await maybeOne<{ id: string; amount_minor: number; status: string }>(
    tx,
    args.paymentAttemptId
      ? `SELECT id, amount_minor, status FROM payment_attempts WHERE id = $2 AND ad_campaign_id = $1`
      : `SELECT id, amount_minor, status FROM payment_attempts WHERE ad_campaign_id = $1 AND status = 'succeeded' ORDER BY succeeded_at LIMIT 1`,
    args.paymentAttemptId ? [args.campaignId, args.paymentAttemptId] : [args.campaignId],
  );
  if (!attempt || !['succeeded', 'duplicate'].includes(attempt.status)) {
    throw new DomainError('INVALID_STATE', 'There is no confirmed payment to refund for this promotion.');
  }
  const already = await one<{ s: number }>(
    tx,
    `SELECT coalesce(sum(amount_minor), 0)::bigint AS s FROM refunds WHERE payment_attempt_id = $1 AND status NOT IN ('rejected','failed')`,
    [attempt.id],
  );
  if (args.amountMinor > attempt.amount_minor - already.s) {
    throw new DomainError('VALIDATION_FAILED', 'The refund is more than the amount still refundable on this payment.', {
      refundableMinor: attempt.amount_minor - already.s,
    });
  }
  const status = args.autoApprove && !FOUR_EYES_REASONS.has(args.reason) ? 'approved' : 'requested';
  const refund = await one<RefundRow>(
    tx,
    `INSERT INTO refunds (ad_campaign_id, payment_attempt_id, amount_minor, reason, note, status, requested_by, approved_by, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8) RETURNING *`,
    [args.campaignId, attempt.id, args.amountMinor, args.reason, args.note ?? null, status, args.requestedBy ?? null, args.idempotencyKey],
  );
  await recordAudit(tx, ctx, {
    action: 'refund.created',
    targetKind: 'refund',
    targetId: refund.id,
    data: { adCampaignId: args.campaignId, amountMinor: args.amountMinor, reason: args.reason, status },
  });
  if (status === 'approved') await enqueue(tx, { topic: 'refund.approved', aggregateId: refund.id, dedupeKey: `refund.approved:${refund.id}` });
  return refund;
}

/** Applies a provider-confirmed promotion refund exactly once: ledger, the campaign's refunded total, seller notice. */
async function confirmPromotionRefund(tx: Queryable, refundId: string, campaignId: string, providerReference: string | null): Promise<void> {
  const c = await one<{ shop_id: string }>(tx, 'SELECT shop_id FROM ad_campaigns WHERE id = $1 FOR UPDATE', [campaignId]);
  const r = await one<RefundRow>(tx, 'SELECT * FROM refunds WHERE id = $1 FOR UPDATE', [refundId]);
  if (r.status === 'succeeded') return;
  // A duplicate payment was parked in refunds_payable at capture; everything else was recognised as ad revenue.
  const debit: LedgerLine = BUYER_OWED_REASONS.has(r.reason)
    ? { account: 'refunds_payable', amountMinor: r.amount_minor }
    : { account: 'ad_revenue', amountMinor: r.amount_minor, shopId: c.shop_id };
  await postLedgerTransaction(tx, {
    kind: 'refund_issued',
    description: `Promotion refund ${r.reason.replace(/_/g, ' ')}`,
    idempotencyKey: `refund:${r.id}`,
    lines: [debit, { account: 'provider_clearing', amountMinor: -r.amount_minor }],
  });
  await tx.query(`UPDATE refunds SET status = 'succeeded', provider_reference = coalesce($2, provider_reference), confirmed_at = now(), updated_at = now() WHERE id = $1`, [
    r.id,
    providerReference,
  ]);
  if (!BUYER_OWED_REASONS.has(r.reason)) {
    await tx.query('UPDATE ad_campaigns SET refund_minor = refund_minor + $2, updated_at = now() WHERE id = $1', [campaignId, r.amount_minor]);
  }
  const owner = await one<{ owner_user_id: string }>(tx, 'SELECT owner_user_id FROM shops WHERE id = $1', [c.shop_id]);
  await notifyUser(tx, {
    userId: owner.owner_user_id,
    topic: 'transactional',
    kind: 'promotion_refund_succeeded',
    title: 'Promotion refund confirmed',
    body: 'The payment provider has confirmed your promotion refund. It may take a few days to appear on your statement.',
    link: '/sell/promotions',
    dedupeKey: `refund-succeeded:${r.id}`,
  });
}
