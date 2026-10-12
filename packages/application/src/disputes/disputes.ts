import {
  addDisputeEntryInput,
  appealDisputeInput,
  buyerPartialDecisionInput,
  decideDisputeInput,
  disputeIdInput,
  DISPUTE_REASON_LABEL,
  openDisputeInput,
  respondToDisputeInput,
  type DisputeOutcome,
  type DisputeReason,
} from '@thrift/contracts';
import { assertTransition, DISPUTE_STATUS, DomainError, formatNaira, type DisputeStatus } from '@thrift/domain';
import { isUniqueViolation, many, maybeOne, one, withTransaction, type Queryable } from '@thrift/database';
import { recordAudit } from '../core/audit';
import { requireStaff, requireUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { getSettings } from '../core/settings';
import { parseInput } from '../core/validation';
import { notifyUser } from '../notifications/notify';
import { createRefund } from '../payments/refunds';
import { refreshPayoutForOrder } from '../payouts/payouts';
import { orderRole } from '../fulfilment/shared';

export interface DisputeRow {
  id: string;
  order_id: string;
  opened_by: string;
  reason: DisputeReason;
  description: string;
  status: DisputeStatus;
  outcome: DisputeOutcome | 'withdrawn' | null;
  refund_amount_minor: number | null;
  resolution_note: string | null;
  decided_by: string | null;
  respond_by: Date | null;
  created_at: Date;
  decided_at: Date | null;
  appeal_reason: string | null;
  appealed_at: Date | null;
  [k: string]: unknown;
}

interface OrderForDispute {
  id: string;
  number: string;
  shop_id: string;
  buyer_user_id: string;
  status: string;
  payment_status: string;
  fulfilment_status: string;
  dispute_status: string;
  delivered_at: Date | null;
  dispatched_at: Date | null;
  buyer_confirmed_at: Date | null;
  [k: string]: unknown;
}

const ACTIVE: DisputeStatus[] = ['awaiting_seller', 'awaiting_buyer', 'under_review', 'appealed'];

const isDisputeStaff = (roles: readonly string[]) => roles.some((r) => r === 'support' || r === 'trust_safety' || r === 'admin');

function move(d: DisputeRow, to: DisputeStatus): void {
  if (d.status !== to) assertTransition(DISPUTE_STATUS, d.status, to, 'dispute status');
}

/** What is still refundable on the order's confirmed payment (paid minus refunds requested, in flight or done). */
export async function refundableMinor(db: Queryable, orderId: string): Promise<number> {
  const r = await maybeOne<{ refundable: number }>(
    db,
    `SELECT (pa.amount_minor - coalesce((SELECT sum(r.amount_minor) FROM refunds r WHERE r.payment_attempt_id = pa.id AND r.status NOT IN ('rejected','failed')), 0))::bigint AS refundable
       FROM payment_attempts pa WHERE pa.order_id = $1 AND pa.status = 'succeeded' ORDER BY pa.created_at LIMIT 1`,
    [orderId],
  );
  return Math.max(0, r?.refundable ?? 0);
}

async function lockOrderAndDispute(tx: Queryable, disputeId: string): Promise<{ order: OrderForDispute; dispute: DisputeRow }> {
  if (!/^[0-9a-f-]{36}$/i.test(disputeId)) throw new DomainError('NOT_FOUND', 'Dispute not found.');
  const peek = await maybeOne<{ order_id: string }>(tx, 'SELECT order_id FROM disputes WHERE id = $1', [disputeId]);
  if (!peek) throw new DomainError('NOT_FOUND', 'Dispute not found.');
  const order = await one<OrderForDispute>(tx, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [peek.order_id]);
  const dispute = await one<DisputeRow>(tx, 'SELECT * FROM disputes WHERE id = $1 FOR UPDATE', [disputeId]);
  return { order, dispute };
}

async function assertEvidence(db: Queryable, userId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const r = await one<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM media_assets WHERE id = ANY($1::uuid[]) AND owner_user_id = $2 AND purpose = 'dispute_evidence' AND status = 'ready'`,
    [ids, userId],
  );
  if (r.n !== new Set(ids).size) throw new DomainError('VALIDATION_FAILED', 'Upload your evidence photos again.', { fieldErrors: { evidenceMediaIds: 'Upload the photos again.' } });
}

async function addEntry(
  tx: Queryable,
  args: { disputeId: string; authorUserId: string | null; role: 'buyer' | 'seller' | 'staff' | 'system'; body: string; mediaIds?: string[]; internal?: boolean },
): Promise<void> {
  await tx.query(`INSERT INTO dispute_entries (dispute_id, author_user_id, author_role, body, media_ids, internal) VALUES ($1, $2, $3, $4, $5, $6)`, [
    args.disputeId,
    args.authorUserId,
    args.role,
    args.body.slice(0, 2000),
    args.mediaIds ?? [],
    args.internal ?? false,
  ]);
}

async function notifyParties(tx: Queryable, order: OrderForDispute, to: ('buyer' | 'seller')[], n: { kind: string; title: string; body?: string; dedupeKey: string }): Promise<void> {
  for (const party of to) {
    const userId = party === 'buyer' ? order.buyer_user_id : (await one<{ owner_user_id: string }>(tx, 'SELECT owner_user_id FROM shops WHERE id = $1', [order.shop_id])).owner_user_id;
    await notifyUser(tx, {
      userId,
      topic: 'transactional',
      kind: n.kind,
      title: n.title,
      body: n.body,
      link: party === 'buyer' ? `/orders/${order.id}` : `/sell/orders/${order.id}`,
      dedupeKey: `${n.dedupeKey}:${party}`,
    });
  }
}

/** Which complaint reasons the buyer can use right now, and until when. */
export async function disputeEligibility(db: Queryable, ctx: AppContext, orderId: string): Promise<{ reasons: DisputeReason[]; windowEndsAt: string | null; blockedReason: string | null }> {
  const settings = await getSettings(db);
  const o = await maybeOne<OrderForDispute & { sh_status: string | null; sh_delivered_at: Date | null; dispatch_by: Date | null; transit_days_max: number | null }>(
    db,
    `SELECT o.*, sh.status AS sh_status, sh.delivered_at AS sh_delivered_at, sh.dispatch_by, sh.transit_days_max
       FROM orders o LEFT JOIN shipments sh ON sh.order_id = o.id WHERE o.id = $1`,
    [orderId],
  );
  if (!o) return { reasons: [], windowEndsAt: null, blockedReason: 'Order not found.' };
  if (o.status !== 'confirmed' && o.status !== 'completed') return { reasons: [], windowEndsAt: null, blockedReason: 'Only paid orders can have a dispute.' };
  if (!['paid', 'partially_refunded'].includes(o.payment_status)) return { reasons: [], windowEndsAt: null, blockedReason: 'This order has already been refunded.' };
  if (o.dispute_status === 'open') return { reasons: [], windowEndsAt: null, blockedReason: 'There is already an open dispute on this order.' };
  const prior = await maybeOne(db, `SELECT 1 AS ok FROM disputes WHERE order_id = $1 AND status IN ('resolved','appealed')`, [orderId]);
  if (prior) return { reasons: [], windowEndsAt: null, blockedReason: 'A dispute on this order has already been decided. You can appeal the decision instead.' };
  const now = ctx.now();
  const deliveredAt = o.delivered_at ?? o.sh_delivered_at;
  const reasons: DisputeReason[] = [];
  let windowEndsAt: Date | null = null;
  if (deliveredAt) {
    windowEndsAt = new Date(new Date(deliveredAt).getTime() + settings.dispute_window_days_after_delivery * 86_400_000);
    if (now <= windowEndsAt) {
      reasons.push('undisclosed_defect', 'wrong_item', 'transit_damage', 'other');
      if (!o.buyer_confirmed_at) reasons.unshift('not_delivered');
    }
  } else {
    const base = o.dispatched_at ?? o.dispatch_by;
    const expectedBy = base ? new Date(new Date(base).getTime() + (o.transit_days_max ?? 7) * 86_400_000) : null;
    if (o.sh_status === 'exception' || (expectedBy && now > expectedBy)) reasons.push('not_delivered');
  }
  const blockedReason =
    reasons.length > 0
      ? null
      : deliveredAt
        ? 'The window to report a problem with this order has closed.'
        : 'You can report a missing order once the expected delivery window has passed, or straight away if the courier reports a problem.';
  return { reasons, windowEndsAt: windowEndsAt?.toISOString() ?? null, blockedReason };
}

/** Buyer opens a dispute on a paid order (within the reason's window). The payout is frozen while it is open. */
export async function openDispute(ctx: AppContext, raw: unknown): Promise<{ disputeId: string }> {
  const user = requireUser(ctx);
  const input = parseInput(openDisputeInput, raw);
  if ((await orderRole(ctx.pool, input.orderId, user.userId)) !== 'buyer') throw new DomainError('NOT_FOUND', 'Order not found.');
  await assertEvidence(ctx.pool, user.userId, input.evidenceMediaIds);
  const settings = await getSettings(ctx.pool);
  try {
    return await withTransaction(ctx.pool, async (tx) => {
      const order = await one<OrderForDispute>(tx, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [input.orderId]);
      const eligible = await disputeEligibility(tx, ctx, order.id);
      if (!eligible.reasons.includes(input.reason)) {
        throw new DomainError('INVALID_STATE', eligible.blockedReason ?? `“${DISPUTE_REASON_LABEL[input.reason]}” can’t be reported for this order right now.`, { allowedReasons: eligible.reasons });
      }
      const respondBy = new Date(ctx.now().getTime() + settings.seller_response_hours * 3_600_000);
      const d = await one<{ id: string }>(
        tx,
        `INSERT INTO disputes (order_id, opened_by, reason, description, status, respond_by) VALUES ($1, $2, $3, $4, 'awaiting_seller', $5) RETURNING id`,
        [order.id, user.userId, input.reason, input.description, respondBy],
      );
      await addEntry(tx, { disputeId: d.id, authorUserId: user.userId, role: 'buyer', body: input.description, mediaIds: input.evidenceMediaIds });
      await tx.query(`UPDATE orders SET dispute_status = 'open', updated_at = now() WHERE id = $1`, [order.id]);
      await tx.query(`INSERT INTO order_events (order_id, kind, actor_kind, actor_user_id, data) VALUES ($1, 'dispute_opened', 'buyer', $2, $3)`, [
        order.id,
        user.userId,
        JSON.stringify({ disputeId: d.id, reason: input.reason }),
      ]);
      await refreshPayoutForOrder(tx, ctx, order.id);
      await notifyParties(tx, order, ['seller'], {
        kind: 'dispute_opened',
        title: `The buyer reported a problem with order ${order.number}`,
        body: `${DISPUTE_REASON_LABEL[input.reason]}. Respond within ${settings.seller_response_hours} hours, or support will review it. The payout is on hold meanwhile.`,
        dedupeKey: `dispute-opened:${d.id}`,
      });
      await recordAudit(tx, ctx, { action: 'dispute.opened', targetKind: 'dispute', targetId: d.id, data: { orderId: order.id, reason: input.reason } });
      return { disputeId: d.id };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new DomainError('CONFLICT', 'There is already an open dispute on this order.');
    throw err;
  }
}

/** Closes a dispute with a refund through the payments module (idempotent on the decision key). */
async function resolveDispute(
  tx: Queryable,
  ctx: AppContext,
  order: OrderForDispute,
  d: DisputeRow,
  args: { outcome: DisputeOutcome; amountMinor: number; note: string; decidedBy: string | null; key: string },
): Promise<void> {
  let amount = 0;
  if (args.amountMinor > 0 && args.outcome !== 'no_refund') {
    const refundable = await refundableMinor(tx, order.id);
    amount = Math.min(args.amountMinor, refundable);
    if (amount > 0) {
      await createRefund(tx, ctx, {
        orderId: order.id,
        amountMinor: amount,
        reason: 'dispute_upheld',
        note: args.note.slice(0, 500),
        requestedBy: args.decidedBy,
        autoApprove: true,
        idempotencyKey: `dispute:${d.id}:${args.key}`,
      });
    }
  }
  move(d, 'resolved');
  await tx.query(
    `UPDATE disputes SET status = 'resolved', outcome = $2, refund_amount_minor = $3, resolution_note = $4, decided_by = coalesce($5, decided_by),
            decided_at = $6, updated_at = now() WHERE id = $1`,
    [d.id, args.outcome, amount, args.note, args.decidedBy, ctx.now()],
  );
  await tx.query(`UPDATE orders SET dispute_status = 'resolved', updated_at = now() WHERE id = $1`, [order.id]);
  if (args.outcome === 'return_and_refund') {
    await tx.query(`UPDATE orders SET fulfilment_status = 'returned', updated_at = now() WHERE id = $1 AND fulfilment_status IN ('delivered','delivery_exception','in_transit','dispatched')`, [order.id]);
  }
  await refreshPayoutForOrder(tx, ctx, order.id);
  await tx.query(`INSERT INTO order_events (order_id, kind, actor_kind, actor_user_id, data) VALUES ($1, 'dispute_resolved', $2, $3, $4)`, [
    order.id,
    args.decidedBy ? 'staff' : 'system',
    args.decidedBy,
    JSON.stringify({ disputeId: d.id, outcome: args.outcome, refundMinor: amount }),
  ]);
  const outcomeText = amount > 0 ? `${formatNaira(amount)} will be refunded to the buyer.` : 'No refund.';
  await notifyParties(tx, order, ['buyer', 'seller'], {
    kind: 'dispute_resolved',
    title: `Dispute on order ${order.number} resolved`,
    body: outcomeText,
    dedupeKey: `dispute-resolved:${d.id}:${args.key}`,
  });
}

/** Seller responds: accept a full refund, offer a partial refund, or reject with an explanation (→ support review). */
export async function respondToDispute(ctx: AppContext, raw: unknown): Promise<{ disputeId: string; status: DisputeStatus }> {
  const user = requireUser(ctx);
  const input = parseInput(respondToDisputeInput, raw);
  const settings = await getSettings(ctx.pool);
  await assertEvidence(ctx.pool, user.userId, input.evidenceMediaIds);
  return withTransaction(ctx.pool, async (tx) => {
    const { order, dispute: d } = await lockOrderAndDispute(tx, input.disputeId);
    if ((await orderRole(tx, order.id, user.userId)) !== 'seller') throw new DomainError('NOT_FOUND', 'Dispute not found.');
    if (d.status !== 'awaiting_seller' || d.outcome !== null) throw new DomainError('INVALID_STATE', 'This dispute isn’t waiting for your response.');
    if (input.response === 'accept_full_refund') {
      await addEntry(tx, { disputeId: d.id, authorUserId: user.userId, role: 'seller', body: input.message ?? 'Seller accepted a full refund.', mediaIds: input.evidenceMediaIds });
      await resolveDispute(tx, ctx, order, d, { outcome: 'full_refund', amountMinor: await refundableMinor(tx, order.id), note: 'Seller accepted a full refund.', decidedBy: null, key: 'seller-full' });
      return { disputeId: d.id, status: 'resolved' as const };
    }
    if (input.response === 'offer_partial_refund') {
      const refundable = await refundableMinor(tx, order.id);
      if (input.amount! > refundable) {
        throw new DomainError('VALIDATION_FAILED', `You can refund at most ${formatNaira(refundable)}.`, { fieldErrors: { amount: `At most ${formatNaira(refundable)}.` } });
      }
      move(d, 'awaiting_buyer');
      await tx.query(`UPDATE disputes SET status = 'awaiting_buyer', refund_amount_minor = $2, respond_by = $3, updated_at = now() WHERE id = $1`, [
        d.id,
        input.amount,
        new Date(ctx.now().getTime() + settings.seller_response_hours * 3_600_000),
      ]);
      await addEntry(tx, {
        disputeId: d.id,
        authorUserId: user.userId,
        role: 'seller',
        body: `Offered a partial refund of ${formatNaira(input.amount!)}.${input.message ? ` ${input.message}` : ''}`,
        mediaIds: input.evidenceMediaIds,
      });
      await notifyParties(tx, order, ['buyer'], {
        kind: 'dispute_partial_offer',
        title: `The seller offered ${formatNaira(input.amount!)} back on order ${order.number}`,
        body: 'Accept the partial refund, or ask support to review.',
        dedupeKey: `dispute-offer:${d.id}:${input.amount}`,
      });
      return { disputeId: d.id, status: 'awaiting_buyer' as const };
    }
    move(d, 'under_review');
    await tx.query(`UPDATE disputes SET status = 'under_review', respond_by = NULL, updated_at = now() WHERE id = $1`, [d.id]);
    await addEntry(tx, { disputeId: d.id, authorUserId: user.userId, role: 'seller', body: input.message!, mediaIds: input.evidenceMediaIds });
    await notifyParties(tx, order, ['buyer'], {
      kind: 'dispute_under_review',
      title: `Support is reviewing the dispute on order ${order.number}`,
      body: 'The seller disagreed. Support will compare the listing as purchased with the evidence from both sides.',
      dedupeKey: `dispute-review:${d.id}`,
    });
    return { disputeId: d.id, status: 'under_review' as const };
  });
}

/** Buyer accepts the seller's partial refund offer, or escalates to support. */
export async function respondToPartialOffer(ctx: AppContext, raw: unknown): Promise<{ disputeId: string; status: DisputeStatus }> {
  const user = requireUser(ctx);
  const input = parseInput(buyerPartialDecisionInput, raw);
  return withTransaction(ctx.pool, async (tx) => {
    const { order, dispute: d } = await lockOrderAndDispute(tx, input.disputeId);
    if (order.buyer_user_id !== user.userId) throw new DomainError('NOT_FOUND', 'Dispute not found.');
    if (d.status !== 'awaiting_buyer') throw new DomainError('INVALID_STATE', 'There is no offer waiting for your answer.');
    if (input.decision === 'accept') {
      await addEntry(tx, { disputeId: d.id, authorUserId: user.userId, role: 'buyer', body: input.message ?? 'Buyer accepted the partial refund.' });
      await resolveDispute(tx, ctx, order, d, { outcome: 'partial_refund', amountMinor: d.refund_amount_minor ?? 0, note: 'Buyer accepted the seller’s partial refund.', decidedBy: null, key: 'partial-accepted' });
      return { disputeId: d.id, status: 'resolved' as const };
    }
    move(d, 'under_review');
    await tx.query(`UPDATE disputes SET status = 'under_review', respond_by = NULL, updated_at = now() WHERE id = $1`, [d.id]);
    await addEntry(tx, { disputeId: d.id, authorUserId: user.userId, role: 'buyer', body: input.message ?? 'Buyer asked support to review.' });
    return { disputeId: d.id, status: 'under_review' as const };
  });
}

/** Buyer withdraws an active dispute; the payout hold is lifted. */
export async function withdrawDispute(ctx: AppContext, raw: unknown): Promise<{ disputeId: string }> {
  const user = requireUser(ctx);
  const input = parseInput(disputeIdInput, raw);
  return withTransaction(ctx.pool, async (tx) => {
    const { order, dispute: d } = await lockOrderAndDispute(tx, input.disputeId);
    if (order.buyer_user_id !== user.userId) throw new DomainError('NOT_FOUND', 'Dispute not found.');
    if (!['awaiting_seller', 'awaiting_buyer', 'under_review'].includes(d.status) || d.outcome === 'return_and_refund') {
      throw new DomainError('INVALID_STATE', 'This dispute can no longer be withdrawn.');
    }
    move(d, 'withdrawn');
    await tx.query(`UPDATE disputes SET status = 'withdrawn', outcome = 'withdrawn', updated_at = now() WHERE id = $1`, [d.id]);
    await tx.query(`UPDATE orders SET dispute_status = 'resolved', updated_at = now() WHERE id = $1`, [order.id]);
    await addEntry(tx, { disputeId: d.id, authorUserId: user.userId, role: 'buyer', body: 'Buyer withdrew the dispute.' });
    await refreshPayoutForOrder(tx, ctx, order.id);
    await notifyParties(tx, order, ['seller'], { kind: 'dispute_withdrawn', title: `The buyer withdrew the dispute on order ${order.number}`, dedupeKey: `dispute-withdrawn:${d.id}` });
    return { disputeId: d.id };
  });
}

/**
 * Support decides a dispute under review (or an appeal — then by a different staff member than the original
 * decider). The decision compares the claim with the order's immutable purchase snapshot. Money moves only through
 * the payments module; a return-and-refund waits for the seller (or support) to confirm the return first.
 */
export async function decideDispute(ctx: AppContext, raw: unknown): Promise<{ disputeId: string; status: DisputeStatus }> {
  const staff = requireStaff(ctx, 'support', 'trust_safety', 'admin');
  const input = parseInput(decideDisputeInput, raw);
  return withTransaction(ctx.pool, async (tx) => {
    const { order, dispute: d } = await lockOrderAndDispute(tx, input.disputeId);
    if (d.status !== 'under_review' && d.status !== 'appealed') throw new DomainError('INVALID_STATE', 'This dispute isn’t waiting for a decision.');
    if (d.status === 'appealed' && d.decided_by === staff.userId) {
      throw new DomainError('FORBIDDEN', 'An appeal must be decided by a different team member than the original decision.');
    }
    const refundable = await refundableMinor(tx, order.id);
    if (input.outcome === 'partial_refund' && input.refundAmount! > refundable) {
      throw new DomainError('VALIDATION_FAILED', `At most ${formatNaira(refundable)} can still be refunded.`, { fieldErrors: { refundAmount: `At most ${formatNaira(refundable)}.` } });
    }
    const key = d.status === 'appealed' ? 'appeal' : 'decision';
    await addEntry(tx, { disputeId: d.id, authorUserId: staff.userId, role: 'staff', body: `Decision: ${input.outcome.replace(/_/g, ' ')}. ${input.reason}` });
    await recordAudit(tx, ctx, {
      action: d.status === 'appealed' ? 'dispute.appeal_decided' : 'dispute.decided',
      targetKind: 'dispute',
      targetId: d.id,
      reason: input.reason,
      data: { outcome: input.outcome, refundAmount: input.refundAmount ?? null },
    });
    if (input.outcome === 'return_and_refund') {
      // Waits for the item to come back; the refund is created when the return is confirmed.
      if (d.status === 'appealed') throw new DomainError('VALIDATION_FAILED', 'On appeal, choose a refund outcome directly.', { fieldErrors: { outcome: 'Choose full, partial or no refund.' } });
      move(d, 'awaiting_seller');
      const amount = input.refundAmount && input.refundAmount <= refundable ? input.refundAmount : refundable;
      await tx.query(
        `UPDATE disputes SET status = 'awaiting_seller', outcome = 'return_and_refund', refund_amount_minor = $2, resolution_note = $3, decided_by = $4, decided_at = $5, respond_by = NULL, updated_at = now() WHERE id = $1`,
        [d.id, amount, input.reason, staff.userId, ctx.now()],
      );
      await addEntry(tx, {
        disputeId: d.id,
        authorUserId: staff.userId,
        role: 'staff',
        body: `Return instructions: ${input.returnInstructions ?? 'Send the item back to the seller with tracking, then share the tracking reference here.'} The refund of ${formatNaira(amount)} is issued once the seller (or support) confirms the item is back.`,
      });
      await notifyParties(tx, order, ['buyer', 'seller'], {
        kind: 'dispute_return_required',
        title: `Return required for order ${order.number}`,
        body: `Support decided on a return and refund of ${formatNaira(amount)}. See the order for instructions.`,
        dedupeKey: `dispute-return:${d.id}:${key}`,
      });
      return { disputeId: d.id, status: 'awaiting_seller' as const };
    }
    const amount = input.outcome === 'full_refund' ? refundable : input.outcome === 'partial_refund' ? input.refundAmount! : 0;
    await resolveDispute(tx, ctx, order, d, { outcome: input.outcome, amountMinor: amount, note: input.reason, decidedBy: staff.userId, key });
    return { disputeId: d.id, status: 'resolved' as const };
  });
}

/** Seller (or support) confirms a returned item arrived: the decided refund is issued and the dispute closes. */
export async function confirmReturnReceived(ctx: AppContext, raw: unknown): Promise<{ disputeId: string }> {
  const user = requireUser(ctx);
  const input = parseInput(disputeIdInput, raw);
  return withTransaction(ctx.pool, async (tx) => {
    const { order, dispute: d } = await lockOrderAndDispute(tx, input.disputeId);
    const isStaff = isDisputeStaff(user.roles);
    const role = await orderRole(tx, order.id, user.userId).catch(() => null);
    if (role !== 'seller' && !isStaff) throw new DomainError('NOT_FOUND', 'Dispute not found.');
    if (d.status !== 'awaiting_seller' || d.outcome !== 'return_and_refund') throw new DomainError('INVALID_STATE', 'No return is expected for this dispute.');
    await addEntry(tx, { disputeId: d.id, authorUserId: user.userId, role: role === 'seller' ? 'seller' : 'staff', body: 'Confirmed the returned item was received.' });
    if (isStaff && role !== 'seller') await recordAudit(tx, ctx, { action: 'dispute.return_confirmed_by_staff', targetKind: 'dispute', targetId: d.id });
    await resolveDispute(tx, ctx, order, d, { outcome: 'return_and_refund', amountMinor: d.refund_amount_minor ?? 0, note: d.resolution_note ?? 'Return received.', decidedBy: d.decided_by, key: 'return' });
    return { disputeId: d.id };
  });
}

/** Either party appeals a support decision once, within the appeal window. A different team member decides it. */
export async function appealDispute(ctx: AppContext, raw: unknown): Promise<{ disputeId: string }> {
  const user = requireUser(ctx);
  const input = parseInput(appealDisputeInput, raw);
  const settings = await getSettings(ctx.pool);
  return withTransaction(ctx.pool, async (tx) => {
    const { order, dispute: d } = await lockOrderAndDispute(tx, input.disputeId);
    const role = await orderRole(tx, order.id, user.userId);
    if (d.status !== 'resolved' || !d.decided_by || d.outcome === 'withdrawn') throw new DomainError('INVALID_STATE', 'Only a decision made by support can be appealed.');
    if (d.appealed_at) throw new DomainError('INVALID_STATE', 'This decision has already been appealed once.');
    if (!d.decided_at || ctx.now().getTime() > new Date(d.decided_at).getTime() + settings.dispute_appeal_days * 86_400_000) {
      throw new DomainError('EXPIRED', `Appeals must be made within ${settings.dispute_appeal_days} days of the decision.`);
    }
    move(d, 'appealed');
    await tx.query(`UPDATE disputes SET status = 'appealed', appeal_reason = $2, appealed_at = $3, updated_at = now() WHERE id = $1`, [d.id, input.reason, ctx.now()]);
    await tx.query(`UPDATE orders SET dispute_status = 'open', updated_at = now() WHERE id = $1`, [order.id]);
    await addEntry(tx, { disputeId: d.id, authorUserId: user.userId, role, body: `Appeal: ${input.reason}` });
    await refreshPayoutForOrder(tx, ctx, order.id);
    await notifyParties(tx, order, [role === 'buyer' ? 'seller' : 'buyer'], {
      kind: 'dispute_appealed',
      title: `The decision on order ${order.number} was appealed`,
      body: 'A different support team member will review it.',
      dedupeKey: `dispute-appeal:${d.id}`,
    });
    return { disputeId: d.id };
  });
}

/** Adds a message or evidence to an active dispute. Staff can add internal notes that parties never see. */
export async function addDisputeEntry(ctx: AppContext, raw: unknown): Promise<{ disputeId: string }> {
  const user = requireUser(ctx);
  const input = parseInput(addDisputeEntryInput, raw);
  const isStaff = isDisputeStaff(user.roles);
  await assertEvidence(ctx.pool, user.userId, input.evidenceMediaIds);
  return withTransaction(ctx.pool, async (tx) => {
    const { order, dispute: d } = await lockOrderAndDispute(tx, input.disputeId);
    const role = await orderRole(tx, order.id, user.userId).catch(() => null);
    if (!role && !isStaff) throw new DomainError('NOT_FOUND', 'Dispute not found.');
    if (!ACTIVE.includes(d.status)) throw new DomainError('INVALID_STATE', 'This dispute is closed.');
    if (input.internal && !isStaff) throw new DomainError('FORBIDDEN', 'Only support can add internal notes.');
    await addEntry(tx, { disputeId: d.id, authorUserId: user.userId, role: role ?? 'staff', body: input.body, mediaIds: input.evidenceMediaIds, internal: input.internal });
    if (!input.internal && role) {
      await notifyParties(tx, order, [role === 'buyer' ? 'seller' : 'buyer'], {
        kind: 'dispute_message',
        title: `New message on the dispute for order ${order.number}`,
        dedupeKey: `dispute-msg:${d.id}:${Date.now()}`,
      });
    }
    return { disputeId: d.id };
  });
}

/** Worker: disputes the seller (or buyer, on a partial offer) didn't answer in time go to support review. */
export async function escalateOverdueDisputes(ctx: AppContext, batchSize = 100): Promise<{ escalated: number }> {
  const due = await many<{ id: string }>(
    ctx.pool,
    `SELECT id FROM disputes WHERE status IN ('awaiting_seller','awaiting_buyer') AND outcome IS NULL AND respond_by < $1 ORDER BY respond_by LIMIT $2`,
    [ctx.now(), batchSize],
  );
  let escalated = 0;
  for (const r of due) {
    const ok = await withTransaction(ctx.pool, async (tx) => {
      const { order, dispute: d } = await lockOrderAndDispute(tx, r.id);
      if (!['awaiting_seller', 'awaiting_buyer'].includes(d.status) || d.outcome !== null || !d.respond_by || new Date(d.respond_by) >= ctx.now()) return false;
      move(d, 'under_review');
      await tx.query(`UPDATE disputes SET status = 'under_review', respond_by = NULL, updated_at = now() WHERE id = $1`, [d.id]);
      await addEntry(tx, { disputeId: d.id, authorUserId: null, role: 'system', body: 'No response in time — passed to support for review.' });
      await notifyParties(tx, order, ['buyer', 'seller'], {
        kind: 'dispute_escalated',
        title: `Support is reviewing the dispute on order ${order.number}`,
        dedupeKey: `dispute-escalated:${d.id}`,
      });
      return true;
    });
    if (ok) escalated++;
  }
  return { escalated };
}
