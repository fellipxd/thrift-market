import { DELIVERY_METHOD_LABEL, DomainError, TRACKING_CONFIDENCE_LABEL, type DeliveryMethod, type TrackingConfidence } from '@thrift/domain';
import { many, maybeOne, one, type Queryable } from '@thrift/database';
import { requireOwnShop, requireStaff, requireUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { mediaPath } from '../media/media';
import { ledgerBalances, unbalancedLedgerTransactions, type LedgerBalance } from '../ledger/ledger';

export const ORDER_STATUS_LABEL: Record<string, string> = {
  pending_payment: 'Awaiting payment',
  confirmed: 'Confirmed',
  completed: 'Completed',
  cancelled: 'Cancelled',
};
export const PAYMENT_STATUS_LABEL: Record<string, string> = {
  pending: 'Not paid yet',
  paid: 'Paid',
  failed: 'Payment not completed',
  refund_pending: 'Refund in progress',
  partially_refunded: 'Partly refunded',
  refunded: 'Refunded',
};
export const FULFILMENT_STATUS_LABEL: Record<string, string> = {
  unfulfilled: 'Not started',
  awaiting_dispatch: 'Awaiting dispatch',
  dispatched: 'Dispatched',
  in_transit: 'In transit',
  delivered: 'Delivered',
  delivery_exception: 'Delivery problem',
  returned: 'Returned',
  cancelled: 'Cancelled',
};
export const PAYOUT_STATUS_LABEL: Record<string, string> = {
  not_applicable: '—',
  held: 'Held until delivery is confirmed',
  eligible: 'Ready to release',
  processing: 'Being sent',
  released: 'Paid out',
  paid: 'Paid out',
  failed: 'Transfer failed — retrying',
  blocked: 'On hold: dispute open',
  reversed: 'Cancelled (refunded)',
  cancelled: 'Cancelled (refunded)',
};

export interface OrderListItem {
  id: string;
  number: string;
  createdAt: string;
  title: string;
  photoUrl: string | null;
  totalMinor: number;
  status: string;
  statusLabel: string;
  paymentStatus: string;
  paymentLabel: string;
  fulfilmentStatus: string;
  fulfilmentLabel: string;
  counterpart: string;
}

interface ListRow {
  id: string;
  number: string;
  created_at: Date;
  snapshot: { title?: string; media?: string[] };
  total_minor: number;
  status: string;
  payment_status: string;
  fulfilment_status: string;
  counterpart: string;
  [k: string]: unknown;
}

function toListItem(r: ListRow): OrderListItem {
  const key = r.snapshot?.media?.[0];
  return {
    id: r.id,
    number: r.number,
    createdAt: new Date(r.created_at).toISOString(),
    title: r.snapshot?.title ?? 'Item',
    photoUrl: key ? mediaPath(key, 'thumb') : null,
    totalMinor: r.total_minor,
    status: r.status,
    statusLabel: ORDER_STATUS_LABEL[r.status] ?? r.status,
    paymentStatus: r.payment_status,
    paymentLabel: PAYMENT_STATUS_LABEL[r.payment_status] ?? r.payment_status,
    fulfilmentStatus: r.fulfilment_status,
    fulfilmentLabel: FULFILMENT_STATUS_LABEL[r.fulfilment_status] ?? r.fulfilment_status,
    counterpart: r.counterpart,
  };
}

function decodeCursor(c: string | null | undefined): { createdAt: string; id: string } | null {
  if (!c) return null;
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as [string, string];
    if (Number.isNaN(Date.parse(createdAt)) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
const encodeCursor = (r: ListRow) => Buffer.from(JSON.stringify([new Date(r.created_at).toISOString(), r.id])).toString('base64url');

export async function buyerOrders(ctx: AppContext, opts: { cursor?: string | null } = {}): Promise<{ items: OrderListItem[]; nextCursor: string | null }> {
  const user = requireUser(ctx);
  const cur = decodeCursor(opts.cursor);
  const rows = await many<ListRow>(
    ctx.pool,
    `SELECT o.id, o.number, o.created_at, oi.snapshot, o.total_minor, o.status, o.payment_status, o.fulfilment_status, s.name AS counterpart
       FROM orders o JOIN shops s ON s.id = o.shop_id
       JOIN LATERAL (SELECT snapshot FROM order_items WHERE order_id = o.id ORDER BY created_at LIMIT 1) oi ON true
      WHERE o.buyer_user_id = $1 ${cur ? 'AND (o.created_at, o.id) < ($2::timestamptz, $3::uuid)' : ''}
      ORDER BY o.created_at DESC, o.id DESC LIMIT ${cur ? '$4' : '$2'}`,
    cur ? [user.userId, cur.createdAt, cur.id, 21] : [user.userId, 21],
  );
  return { items: rows.slice(0, 20).map(toListItem), nextCursor: rows.length > 20 ? encodeCursor(rows[19]!) : null };
}

export type SellerOrderFilter = 'to_ship' | 'in_transit' | 'delivered' | 'awaiting_payment' | 'cancelled' | 'all';

export async function sellerOrders(ctx: AppContext, opts: { filter?: string | null; cursor?: string | null } = {}): Promise<{ items: OrderListItem[]; nextCursor: string | null; counts: Record<SellerOrderFilter, number> }> {
  const shop = await requireOwnShop(ctx.pool, ctx);
  const filter = (['to_ship', 'in_transit', 'delivered', 'awaiting_payment', 'cancelled', 'all'] as const).includes(opts.filter as never) ? (opts.filter as SellerOrderFilter) : 'to_ship';
  const where: Record<SellerOrderFilter, string> = {
    to_ship: `o.status = 'confirmed' AND o.fulfilment_status = 'awaiting_dispatch'`,
    in_transit: `o.status = 'confirmed' AND o.fulfilment_status IN ('dispatched','in_transit','delivery_exception')`,
    delivered: `o.fulfilment_status = 'delivered' AND o.status <> 'cancelled'`,
    awaiting_payment: `o.status = 'pending_payment'`,
    cancelled: `o.status = 'cancelled'`,
    all: 'true',
  };
  const cur = decodeCursor(opts.cursor);
  const params: unknown[] = [shop.id];
  let cursorSql = '';
  if (cur) {
    params.push(cur.createdAt, cur.id);
    cursorSql = `AND (o.created_at, o.id) < ($2::timestamptz, $3::uuid)`;
  }
  params.push(31);
  const rows = await many<ListRow>(
    ctx.pool,
    `SELECT o.id, o.number, o.created_at, oi.snapshot, o.total_minor, o.status, o.payment_status, o.fulfilment_status, u.display_name AS counterpart
       FROM orders o JOIN users u ON u.id = o.buyer_user_id
       JOIN LATERAL (SELECT snapshot FROM order_items WHERE order_id = o.id ORDER BY created_at LIMIT 1) oi ON true
      WHERE o.shop_id = $1 AND ${where[filter]} ${cursorSql}
      ORDER BY o.created_at DESC, o.id DESC LIMIT $${params.length}`,
    params,
  );
  const c = await one<Record<SellerOrderFilter, number>>(
    ctx.pool,
    `SELECT count(*) FILTER (WHERE ${where.to_ship})::int AS to_ship, count(*) FILTER (WHERE ${where.in_transit})::int AS in_transit,
            count(*) FILTER (WHERE ${where.delivered})::int AS delivered, count(*) FILTER (WHERE ${where.awaiting_payment})::int AS awaiting_payment,
            count(*) FILTER (WHERE ${where.cancelled})::int AS cancelled, count(*)::int AS all
       FROM orders o WHERE o.shop_id = $1`,
    [shop.id],
  );
  return { items: rows.slice(0, 30).map(toListItem), nextCursor: rows.length > 30 ? encodeCursor(rows[29]!) : null, counts: c };
}

export interface OrderDetail {
  id: string;
  number: string;
  viewer: 'buyer' | 'seller';
  createdAt: string;
  status: string;
  statusLabel: string;
  paymentStatus: string;
  paymentLabel: string;
  fulfilmentStatus: string;
  fulfilmentLabel: string;
  payoutStatus: string;
  payoutLabel: string;
  disputeStatus: string;
  source: string;
  cancelReason: string | null;
  shop: { id: string; name: string; slug: string };
  buyerName: string;
  items: {
    listingId: string;
    title: string;
    quantity: number;
    unitPriceMinor: number;
    conditionLabel: string | null;
    sizeLabel: string | null;
    flaws: { description: string; location: string | null; severity: string }[];
    flawsDeclaration: string | null;
    measurements: Record<string, number>;
    photoUrls: string[];
    listingVersion: number | null;
  }[];
  totals: { itemsTotalMinor: number; shippingMinor: number; buyerFeeMinor: number; totalMinor: number; commissionMinor: number };
  delivery: { method: DeliveryMethod; methodLabel: string; dispatchDays: number | null; transitDaysMin: number | null; transitDaysMax: number | null; trackingNote: string | null };
  /** Seller sees the address only after payment; buyers always see their own snapshot. */
  shippingAddress: Record<string, string | null> | null;
  reservation: { expiresAt: string; status: string } | null;
  payment: { latestStatus: string | null; authorizationUrl: string | null; canRetry: boolean };
  shipment: { status: string; confidence: TrackingConfidence; confidenceLabel: string; trackingReference: string | null; dispatchBy: string | null; lastEventAt: string | null } | null;
  refunds: { id: string; amountMinor: number; reason: string; status: string; createdAt: string }[];
  payout: { amountMinor: number; status: string; statusLabel: string; eligibleAt: string | null } | null;
  timeline: { at: string; kind: string; label: string }[];
  policyVersions: Record<string, { version: string; title: string }>;
  serverNow: string;
}

const EVENT_LABEL: Record<string, string> = {
  order_created: 'Order placed — item reserved for you',
  payment_confirmed: 'Payment confirmed by the payment provider',
  payment_confirmed_late_reallocated: 'Late payment confirmed — item was still available',
  payment_failed: 'Payment attempt not completed',
  hold_expired: 'Reservation expired before payment',
  buyer_cancelled_unpaid: 'Cancelled before payment',
  late_payment_refunded: 'Payment arrived after the item was gone — refund started',
  refund_created: 'Refund started',
  refund_succeeded: 'Refund confirmed by the payment provider',
  seller_cancelled: 'Cancelled by the seller',
  payout_released: 'Seller paid',
  dispatched: 'Dispatched by the seller',
  dispatch_late: 'Dispatch is late',
  courier_delivered: 'Delivered (courier scan)',
  delivery_exception: 'Delivery problem reported by the courier',
  buyer_confirmed: 'Buyer confirmed delivery',
  delivery_staff_verified: 'Delivery verified by support',
  delivery_confirmation_reminder: 'Buyer reminded to confirm delivery',
  dispute_opened: 'Problem reported — payout on hold',
  dispute_resolved: 'Dispute resolved',
};

/** Order detail for its buyer or a member of the selling shop; anyone else gets NOT_FOUND. */
export async function getOrderDetail(ctx: AppContext, orderId: string): Promise<OrderDetail> {
  const user = requireUser(ctx);
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) throw new DomainError('NOT_FOUND', 'Order not found.');
  const o = await maybeOne<{
    id: string; number: string; buyer_user_id: string; shop_id: string; created_at: Date; status: string; payment_status: string;
    fulfilment_status: string; payout_status: string; dispute_status: string; source: string; cancel_reason: string | null;
    items_total_minor: number; shipping_minor: number; buyer_fee_minor: number; total_minor: number; commission_minor: number;
    delivery_method: DeliveryMethod; delivery_terms: Record<string, unknown>; shipping_address: Record<string, string | null> | null;
    policy_versions: Record<string, { version: string; title: string }>; reservation_id: string | null;
    shop_name: string; shop_slug: string; buyer_name: string; is_member: boolean; [k: string]: unknown;
  }>(
    ctx.pool,
    `SELECT o.*, s.name AS shop_name, s.slug AS shop_slug, u.display_name AS buyer_name,
            EXISTS (SELECT 1 FROM shop_members m WHERE m.shop_id = o.shop_id AND m.user_id = $2) AS is_member
       FROM orders o JOIN shops s ON s.id = o.shop_id JOIN users u ON u.id = o.buyer_user_id WHERE o.id = $1`,
    [orderId, user.userId],
  );
  if (!o || (o.buyer_user_id !== user.userId && !o.is_member)) throw new DomainError('NOT_FOUND', 'Order not found.');
  const viewer: 'buyer' | 'seller' = o.buyer_user_id === user.userId ? 'buyer' : 'seller';
  const items = await many<{ listing_id: string; quantity: number; unit_price_minor: number; snapshot: Record<string, unknown> }>(
    ctx.pool,
    'SELECT listing_id, quantity, unit_price_minor, snapshot FROM order_items WHERE order_id = $1 ORDER BY created_at',
    [o.id],
  );
  const reservation = o.reservation_id
    ? await maybeOne<{ expires_at: Date; status: string }>(ctx.pool, 'SELECT expires_at, status FROM reservations WHERE id = $1', [o.reservation_id])
    : null;
  const latest = await maybeOne<{ status: string; authorization_url: string | null }>(
    ctx.pool,
    'SELECT status, authorization_url FROM payment_attempts WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1',
    [o.id],
  );
  const shipment = await maybeOne<{ status: string; confidence: TrackingConfidence; tracking_reference: string | null; dispatch_by: Date | null; last_event_at: Date | null }>(
    ctx.pool,
    'SELECT status, confidence, tracking_reference, dispatch_by, last_event_at FROM shipments WHERE order_id = $1',
    [o.id],
  );
  const refunds = await many<{ id: string; amount_minor: number; reason: string; status: string; created_at: Date }>(
    ctx.pool,
    'SELECT id, amount_minor, reason, status, created_at FROM refunds WHERE order_id = $1 ORDER BY created_at',
    [o.id],
  );
  const payout = viewer === 'seller' ? await maybeOne<{ amount_minor: number; status: string; eligible_at: Date | null }>(ctx.pool, 'SELECT amount_minor, status, eligible_at FROM payouts WHERE order_id = $1', [o.id]) : null;
  const events = await many<{ created_at: Date; kind: string }>(ctx.pool, `SELECT created_at, kind FROM order_events WHERE order_id = $1 AND kind NOT IN ('delivery_review_needed') ORDER BY id`, [o.id]);
  const dt = o.delivery_terms as { dispatchDays?: number; transitDaysMin?: number; transitDaysMax?: number; trackingNote?: string };
  const paidOrLater = ['paid', 'refund_pending', 'partially_refunded', 'refunded'].includes(o.payment_status) && o.status !== 'pending_payment';
  return {
    id: o.id,
    number: o.number,
    viewer,
    createdAt: new Date(o.created_at).toISOString(),
    status: o.status,
    statusLabel: ORDER_STATUS_LABEL[o.status] ?? o.status,
    paymentStatus: o.payment_status,
    paymentLabel: PAYMENT_STATUS_LABEL[o.payment_status] ?? o.payment_status,
    fulfilmentStatus: o.fulfilment_status,
    fulfilmentLabel: FULFILMENT_STATUS_LABEL[o.fulfilment_status] ?? o.fulfilment_status,
    payoutStatus: o.payout_status,
    payoutLabel: PAYOUT_STATUS_LABEL[o.payout_status] ?? o.payout_status,
    disputeStatus: o.dispute_status,
    source: o.source,
    cancelReason: o.cancel_reason,
    shop: { id: o.shop_id, name: o.shop_name, slug: o.shop_slug },
    buyerName: o.buyer_name,
    items: items.map((i) => {
      const s = i.snapshot as { title?: string; conditionLabel?: string | null; sizeLabel?: string | null; flaws?: { description: string; location: string | null; severity: string }[]; flawsDeclaration?: string | null; measurements?: Record<string, number>; media?: string[]; listingVersion?: number | null };
      return {
        listingId: i.listing_id,
        title: s.title ?? 'Item',
        quantity: i.quantity,
        unitPriceMinor: i.unit_price_minor,
        conditionLabel: s.conditionLabel ?? null,
        sizeLabel: s.sizeLabel ?? null,
        flaws: s.flaws ?? [],
        flawsDeclaration: s.flawsDeclaration ?? null,
        measurements: s.measurements ?? {},
        photoUrls: (s.media ?? []).map((k) => mediaPath(k, 'thumb')),
        listingVersion: s.listingVersion ?? null,
      };
    }),
    totals: { itemsTotalMinor: o.items_total_minor, shippingMinor: o.shipping_minor, buyerFeeMinor: o.buyer_fee_minor, totalMinor: o.total_minor, commissionMinor: viewer === 'seller' ? o.commission_minor : 0 },
    delivery: {
      method: o.delivery_method,
      methodLabel: DELIVERY_METHOD_LABEL[o.delivery_method],
      dispatchDays: dt.dispatchDays ?? null,
      transitDaysMin: dt.transitDaysMin ?? null,
      transitDaysMax: dt.transitDaysMax ?? null,
      trackingNote: dt.trackingNote ?? null,
    },
    shippingAddress: viewer === 'buyer' || paidOrLater ? o.shipping_address : null,
    reservation: reservation ? { expiresAt: new Date(reservation.expires_at).toISOString(), status: reservation.status } : null,
    payment: {
      latestStatus: latest?.status ?? null,
      authorizationUrl: viewer === 'buyer' && latest?.status === 'pending' ? latest.authorization_url : null,
      canRetry: viewer === 'buyer' && o.status === 'pending_payment' && reservation?.status === 'active' && new Date(reservation.expires_at) > ctx.now(),
    },
    shipment: shipment
      ? {
          status: shipment.status,
          confidence: shipment.confidence,
          confidenceLabel: TRACKING_CONFIDENCE_LABEL[shipment.confidence],
          trackingReference: shipment.tracking_reference,
          dispatchBy: shipment.dispatch_by ? new Date(shipment.dispatch_by).toISOString() : null,
          lastEventAt: shipment.last_event_at ? new Date(shipment.last_event_at).toISOString() : null,
        }
      : null,
    refunds: refunds.map((r) => ({ id: r.id, amountMinor: r.amount_minor, reason: r.reason, status: r.status, createdAt: new Date(r.created_at).toISOString() })),
    payout: payout ? { amountMinor: payout.amount_minor, status: payout.status, statusLabel: PAYOUT_STATUS_LABEL[payout.status] ?? payout.status, eligibleAt: payout.eligible_at ? new Date(payout.eligible_at).toISOString() : null } : null,
    timeline: events.map((e) => ({ at: new Date(e.created_at).toISOString(), kind: e.kind, label: EVENT_LABEL[e.kind] ?? e.kind.replace(/_/g, ' ') })),
    policyVersions: o.policy_versions ?? {},
    serverNow: ctx.now().toISOString(),
  };
}

export interface SellerPayoutSummary {
  grossSalesMinor: number;
  refundsMinor: number;
  feesMinor: number;
  pendingPayoutMinor: number;
  settledPayoutMinor: number;
  payouts: { id: string; orderId: string; orderNumber: string; amountMinor: number; status: string; statusLabel: string; eligibleAt: string | null; releasedAt: string | null }[];
  account: { status: string; last4: string; bankName: string; usableAfter: string } | null;
}

/** Separate numbers for gross sales, refunds, fees, pending payout and settled payout (never blended). */
export async function sellerPayoutSummary(ctx: AppContext): Promise<SellerPayoutSummary> {
  const shop = await requireOwnShop(ctx.pool, ctx);
  const t = await one<{ gross: number; fees: number; refunds: number; pending: number; settled: number }>(
    ctx.pool,
    `SELECT
       coalesce((SELECT sum(items_total_minor) FROM orders WHERE shop_id = $1 AND paid_at IS NOT NULL AND status <> 'pending_payment'
                 AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.order_id = orders.id AND r.reason = 'late_payment_after_release')), 0)::bigint AS gross,
       coalesce((SELECT sum(commission_minor) FROM orders WHERE shop_id = $1 AND status IN ('confirmed','completed')), 0)::bigint AS fees,
       coalesce((SELECT sum(r.amount_minor) FROM refunds r JOIN orders o ON o.id = r.order_id WHERE o.shop_id = $1 AND r.status = 'succeeded'
                 AND r.reason NOT IN ('late_payment_after_release','duplicate_payment')), 0)::bigint AS refunds,
       coalesce((SELECT sum(amount_minor) FROM payouts WHERE shop_id = $1 AND status IN ('held','eligible','processing','blocked','failed')), 0)::bigint AS pending,
       coalesce((SELECT sum(amount_minor) FROM payouts WHERE shop_id = $1 AND status = 'paid'), 0)::bigint AS settled`,
    [shop.id],
  );
  const payouts = await many<{ id: string; order_id: string; number: string; amount_minor: number; status: string; eligible_at: Date | null; released_at: Date | null }>(
    ctx.pool,
    `SELECT po.id, po.order_id, o.number, po.amount_minor, po.status, po.eligible_at, po.released_at
       FROM payouts po JOIN orders o ON o.id = po.order_id WHERE po.shop_id = $1 ORDER BY po.created_at DESC LIMIT 100`,
    [shop.id],
  );
  const acct = await maybeOne<{ status: string; account_number_last4: string; bank_name: string; usable_after: Date }>(
    ctx.pool,
    `SELECT status, account_number_last4, bank_name, usable_after FROM payout_accounts WHERE shop_id = $1 AND status IN ('pending','verified') LIMIT 1`,
    [shop.id],
  );
  return {
    grossSalesMinor: t.gross,
    refundsMinor: t.refunds,
    feesMinor: t.fees,
    pendingPayoutMinor: t.pending,
    settledPayoutMinor: t.settled,
    payouts: payouts.map((p) => ({
      id: p.id,
      orderId: p.order_id,
      orderNumber: p.number,
      amountMinor: p.amount_minor,
      status: p.status,
      statusLabel: PAYOUT_STATUS_LABEL[p.status] ?? p.status,
      eligibleAt: p.eligible_at ? new Date(p.eligible_at).toISOString() : null,
      releasedAt: p.released_at ? new Date(p.released_at).toISOString() : null,
    })),
    account: acct ? { status: acct.status, last4: acct.account_number_last4, bankName: acct.bank_name, usableAfter: new Date(acct.usable_after).toISOString() } : null,
  };
}

export interface FinanceOverview {
  unresolvedAttempts: { reference: string; orderNumber: string | null; status: string; amountMinor: number; createdAt: string; failureReason: string | null }[];
  refundsAwaitingDecision: { id: string; orderNumber: string; amountMinor: number; reason: string; note: string | null; requestedBy: string | null; createdAt: string }[];
  refundsInFlight: { id: string; orderNumber: string; amountMinor: number; reason: string; status: string; attempts: number }[];
  payoutsByStatus: { status: string; count: number; amountMinor: number }[];
  failedWebhooks: { id: string; provider: string; eventType: string; attempts: number; lastError: string | null; receivedAt: string }[];
  ledger: LedgerBalance[];
  unbalanced: { transactionId: string; sumMinor: number }[];
}

export async function financeOverview(ctx: AppContext): Promise<FinanceOverview> {
  requireStaff(ctx, 'finance', 'admin');
  const db: Queryable = ctx.pool;
  const [unresolved, awaiting, inflight, payouts, webhooks, ledger, unbalanced] = await Promise.all([
    many<{ reference: string; number: string | null; status: string; amount_minor: number; created_at: Date; failure_reason: string | null }>(
      db,
      `SELECT pa.reference, o.number, pa.status, pa.amount_minor, pa.created_at, pa.failure_reason FROM payment_attempts pa LEFT JOIN orders o ON o.id = pa.order_id
        WHERE pa.status IN ('uncertain','initiated') OR (pa.status = 'pending' AND pa.created_at < now() - interval '30 minutes')
        ORDER BY pa.created_at LIMIT 100`,
    ),
    many<{ id: string; number: string; amount_minor: number; reason: string; note: string | null; requested_by: string | null; created_at: Date }>(
      db,
      `SELECT r.id, o.number, r.amount_minor, r.reason, r.note, u.display_name AS requested_by, r.created_at FROM refunds r JOIN orders o ON o.id = r.order_id
         LEFT JOIN users u ON u.id = r.requested_by WHERE r.status = 'requested' ORDER BY r.created_at`,
    ),
    many<{ id: string; number: string; amount_minor: number; reason: string; status: string; attempts: number }>(
      db,
      `SELECT r.id, o.number, r.amount_minor, r.reason, r.status, r.attempts FROM refunds r JOIN orders o ON o.id = r.order_id
        WHERE r.status IN ('approved','processing','failed') ORDER BY r.updated_at LIMIT 100`,
    ),
    many<{ status: string; n: number; s: number }>(db, `SELECT status, count(*)::int AS n, coalesce(sum(amount_minor),0)::bigint AS s FROM payouts GROUP BY status ORDER BY status`),
    many<{ id: string; provider: string; event_type: string; attempts: number; last_error: string | null; received_at: Date }>(
      db,
      `SELECT id, provider, event_type, attempts, last_error, received_at FROM webhook_inbox WHERE status = 'failed' OR (status = 'pending' AND attempts > 2) ORDER BY received_at DESC LIMIT 50`,
    ),
    ledgerBalances(db),
    unbalancedLedgerTransactions(db),
  ]);
  return {
    unresolvedAttempts: unresolved.map((a) => ({ reference: a.reference, orderNumber: a.number, status: a.status, amountMinor: a.amount_minor, createdAt: new Date(a.created_at).toISOString(), failureReason: a.failure_reason })),
    refundsAwaitingDecision: awaiting.map((r) => ({ id: r.id, orderNumber: r.number, amountMinor: r.amount_minor, reason: r.reason, note: r.note, requestedBy: r.requested_by, createdAt: new Date(r.created_at).toISOString() })),
    refundsInFlight: inflight.map((r) => ({ id: r.id, orderNumber: r.number, amountMinor: r.amount_minor, reason: r.reason, status: r.status, attempts: r.attempts })),
    payoutsByStatus: payouts.map((p) => ({ status: p.status, count: p.n, amountMinor: p.s })),
    failedWebhooks: webhooks.map((w) => ({ id: w.id, provider: w.provider, eventType: w.event_type, attempts: w.attempts, lastError: w.last_error, receivedAt: new Date(w.received_at).toISOString() })),
    ledger,
    unbalanced,
  };
}
