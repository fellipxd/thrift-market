import { DISPUTE_REASON_LABEL, type DisputeReason } from '@thrift/contracts';
import { DomainError, type DisputeStatus } from '@thrift/domain';
import { many, maybeOne, one } from '@thrift/database';
import { requireStaff, requireUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { getSettings } from '../core/settings';
import { mediaPath, signMediaUrl } from '../media/media';
import { orderRole } from '../fulfilment/shared';
import { orderTracking, type OrderTracking } from '../fulfilment/queries';
import { disputeEligibility, refundableMinor } from './disputes';

export const DISPUTE_STATUS_LABEL: Record<DisputeStatus, string> = {
  awaiting_seller: 'Waiting for the seller',
  awaiting_buyer: 'Waiting for the buyer',
  under_review: 'Support is reviewing',
  resolved: 'Resolved',
  withdrawn: 'Withdrawn',
  appealed: 'Appeal under review',
};

export interface DisputeEntryView {
  id: string;
  role: 'buyer' | 'seller' | 'staff' | 'system';
  roleLabel: string;
  body: string;
  internal: boolean;
  at: string;
  photos: { url: string; thumbUrl: string }[];
}

export interface DisputeView {
  id: string;
  orderId: string;
  reason: DisputeReason;
  reasonLabel: string;
  status: DisputeStatus;
  statusLabel: string;
  outcome: string | null;
  refundAmountMinor: number | null;
  resolutionNote: string | null;
  respondBy: string | null;
  createdAt: string;
  decidedAt: string | null;
  appealedAt: string | null;
  entries: DisputeEntryView[];
}

export interface OrderDisputeState {
  viewer: 'buyer' | 'seller';
  dispute: DisputeView | null;
  eligibility: { reasons: { value: DisputeReason; label: string }[]; windowEndsAt: string | null; blockedReason: string | null } | null;
  actions: {
    canWithdraw: boolean;
    canRespond: boolean;
    canAnswerOffer: boolean;
    canAppeal: boolean;
    canAddEntry: boolean;
    canConfirmReturn: boolean;
  };
  refundableMinor: number;
  serverNow: string;
}

const ROLE_LABEL = { buyer: 'Buyer', seller: 'Seller', staff: 'Thrift Market support', system: 'Thrift Market' } as const;

async function loadDispute(ctx: AppContext, where: { id?: string; orderId?: string }, includeInternal: boolean): Promise<DisputeView | null> {
  const d = await maybeOne<{
    id: string; order_id: string; reason: DisputeReason; status: DisputeStatus; outcome: string | null; refund_amount_minor: number | null; resolution_note: string | null;
    respond_by: Date | null; created_at: Date; decided_at: Date | null; appealed_at: Date | null;
  }>(
    ctx.pool,
    where.id ? 'SELECT * FROM disputes WHERE id = $1' : 'SELECT * FROM disputes WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1',
    [where.id ?? where.orderId],
  );
  if (!d) return null;
  const entries = await many<{ id: string; author_role: DisputeEntryView['role']; body: string; internal: boolean; created_at: Date; media_ids: string[] }>(
    ctx.pool,
    `SELECT id, author_role, body, internal, created_at, media_ids FROM dispute_entries WHERE dispute_id = $1 ${includeInternal ? '' : 'AND NOT internal'} ORDER BY created_at, id`,
    [d.id],
  );
  const mediaIds = [...new Set(entries.flatMap((e) => e.media_ids))];
  const media = mediaIds.length
    ? await many<{ id: string; storage_key: string }>(ctx.pool, `SELECT id, storage_key FROM media_assets WHERE id = ANY($1::uuid[]) AND status = 'ready'`, [mediaIds])
    : [];
  const keyFor = new Map(media.map((m) => [m.id, m.storage_key]));
  return {
    id: d.id,
    orderId: d.order_id,
    reason: d.reason,
    reasonLabel: DISPUTE_REASON_LABEL[d.reason],
    status: d.status,
    statusLabel: DISPUTE_STATUS_LABEL[d.status],
    outcome: d.outcome,
    refundAmountMinor: d.refund_amount_minor,
    resolutionNote: d.resolution_note,
    respondBy: d.respond_by ? new Date(d.respond_by).toISOString() : null,
    createdAt: new Date(d.created_at).toISOString(),
    decidedAt: d.decided_at ? new Date(d.decided_at).toISOString() : null,
    appealedAt: d.appealed_at ? new Date(d.appealed_at).toISOString() : null,
    entries: entries.map((e) => ({
      id: e.id,
      role: e.author_role,
      roleLabel: ROLE_LABEL[e.author_role],
      body: e.body,
      internal: e.internal,
      at: new Date(e.created_at).toISOString(),
      photos: e.media_ids
        .map((id) => keyFor.get(id))
        .filter((k): k is string => !!k)
        .map((k) => ({ url: signMediaUrl(ctx, k, 900), thumbUrl: signMediaUrl(ctx, k, 900, 'thumb') })),
    })),
  };
}

/** The dispute (if any) on an order for its buyer or seller, with the actions they can take and the buyer's options to open one. */
export async function orderDisputeState(ctx: AppContext, orderId: string): Promise<OrderDisputeState> {
  const user = requireUser(ctx);
  const viewer = await orderRole(ctx.pool, orderId, user.userId);
  const settings = await getSettings(ctx.pool);
  const dispute = await loadDispute(ctx, { orderId }, false);
  const now = ctx.now();
  const active = dispute && ['awaiting_seller', 'awaiting_buyer', 'under_review', 'appealed'].includes(dispute.status);
  let eligibility: OrderDisputeState['eligibility'] = null;
  if (viewer === 'buyer' && !active) {
    const e = await disputeEligibility(ctx.pool, ctx, orderId);
    eligibility = { reasons: e.reasons.map((r) => ({ value: r, label: DISPUTE_REASON_LABEL[r] })), windowEndsAt: e.windowEndsAt, blockedReason: e.blockedReason };
  }
  const decidedByStaff = dispute ? (await maybeOne<{ decided_by: string | null }>(ctx.pool, 'SELECT decided_by FROM disputes WHERE id = $1', [dispute.id]))?.decided_by : null;
  const returnPending = dispute?.status === 'awaiting_seller' && dispute.outcome === 'return_and_refund';
  return {
    viewer,
    dispute,
    eligibility,
    actions: {
      canWithdraw: viewer === 'buyer' && !!dispute && ['awaiting_seller', 'awaiting_buyer', 'under_review'].includes(dispute.status) && !returnPending,
      canRespond: viewer === 'seller' && dispute?.status === 'awaiting_seller' && dispute.outcome === null,
      canAnswerOffer: viewer === 'buyer' && dispute?.status === 'awaiting_buyer',
      canAppeal:
        !!dispute &&
        dispute.status === 'resolved' &&
        !!decidedByStaff &&
        !dispute.appealedAt &&
        !!dispute.decidedAt &&
        now.getTime() <= new Date(dispute.decidedAt).getTime() + settings.dispute_appeal_days * 86_400_000,
      canAddEntry: !!active,
      canConfirmReturn: viewer === 'seller' && returnPending,
    },
    refundableMinor: await refundableMinor(ctx.pool, orderId),
    serverNow: now.toISOString(),
  };
}

export interface StaffDisputeQueueItem {
  id: string;
  orderId: string;
  orderNumber: string;
  reasonLabel: string;
  status: DisputeStatus;
  statusLabel: string;
  shopName: string;
  totalMinor: number;
  createdAt: string;
  respondBy: string | null;
  overdue: boolean;
}

/** Staff queue ordered by urgency: appeals, then reviews, then overdue responses. */
export async function staffDisputeQueue(ctx: AppContext, opts: { status?: string } = {}): Promise<StaffDisputeQueueItem[]> {
  requireStaff(ctx, 'support', 'trust_safety', 'admin');
  const filter = opts.status === 'all' ? 'true' : opts.status === 'closed' ? `d.status IN ('resolved','withdrawn')` : `d.status IN ('awaiting_seller','awaiting_buyer','under_review','appealed')`;
  const rows = await many<{ id: string; order_id: string; number: string; reason: DisputeReason; status: DisputeStatus; shop_name: string; total_minor: number; created_at: Date; respond_by: Date | null }>(
    ctx.pool,
    `SELECT d.id, d.order_id, o.number, d.reason, d.status, s.name AS shop_name, o.total_minor, d.created_at, d.respond_by
       FROM disputes d JOIN orders o ON o.id = d.order_id JOIN shops s ON s.id = o.shop_id
      WHERE ${filter}
      ORDER BY CASE d.status WHEN 'appealed' THEN 0 WHEN 'under_review' THEN 1 ELSE 2 END, coalesce(d.respond_by, d.created_at) LIMIT 200`,
  );
  const now = ctx.now();
  return rows.map((r) => ({
    id: r.id,
    orderId: r.order_id,
    orderNumber: r.number,
    reasonLabel: DISPUTE_REASON_LABEL[r.reason],
    status: r.status,
    statusLabel: DISPUTE_STATUS_LABEL[r.status],
    shopName: r.shop_name,
    totalMinor: r.total_minor,
    createdAt: new Date(r.created_at).toISOString(),
    respondBy: r.respond_by ? new Date(r.respond_by).toISOString() : null,
    overdue: !!r.respond_by && new Date(r.respond_by) < now,
  }));
}

export interface PurchasedItemSnapshot {
  listingId: string;
  title: string;
  conditionLabel: string | null;
  flawsDeclaration: string | null;
  flaws: { description: string; location?: string | null; severity?: string }[];
  photoUrls: string[];
  version: number | null;
  /** The listing as it is now — staff can see whether the seller edited it after the sale. */
  currentTitle: string | null;
  currentCondition: string | null;
  editedAfterPurchase: boolean;
}

export interface StaffDisputeDetail {
  dispute: DisputeView;
  order: { id: string; number: string; totalMinor: number; paymentStatus: string; fulfilmentStatus: string; buyerName: string; shopName: string; shopSlug: string; createdAt: string };
  purchased: PurchasedItemSnapshot[];
  tracking: OrderTracking | null;
  refunds: { amountMinor: number; status: string; reason: string; createdAt: string }[];
  refundableMinor: number;
  decidedByViewer: boolean;
  appealReason: string | null;
}

/** Staff dispute detail: the immutable purchase snapshot side by side with the evidence (T10), plus internal notes. */
export async function staffDisputeDetail(ctx: AppContext, disputeId: string): Promise<StaffDisputeDetail> {
  const staff = requireStaff(ctx, 'support', 'trust_safety', 'admin');
  if (!/^[0-9a-f-]{36}$/i.test(disputeId)) throw new DomainError('NOT_FOUND', 'Dispute not found.');
  const dispute = await loadDispute(ctx, { id: disputeId }, true);
  if (!dispute) throw new DomainError('NOT_FOUND', 'Dispute not found.');
  const o = await one<{ id: string; number: string; total_minor: number; payment_status: string; fulfilment_status: string; buyer_name: string; shop_name: string; shop_slug: string; created_at: Date }>(
    ctx.pool,
    `SELECT o.id, o.number, o.total_minor, o.payment_status, o.fulfilment_status, u.display_name AS buyer_name, s.name AS shop_name, s.slug AS shop_slug, o.created_at
       FROM orders o JOIN users u ON u.id = o.buyer_user_id JOIN shops s ON s.id = o.shop_id WHERE o.id = $1`,
    [dispute.orderId],
  );
  const items = await many<{ listing_id: string; snapshot: Record<string, unknown>; version: number | null; current_title: string; current_condition: string | null; current_version: number }>(
    ctx.pool,
    `SELECT oi.listing_id, oi.snapshot, lv.version, l.title AS current_title, l.condition AS current_condition, l.version AS current_version
       FROM order_items oi JOIN listings l ON l.id = oi.listing_id LEFT JOIN listing_versions lv ON lv.id = oi.listing_version_id
      WHERE oi.order_id = $1`,
    [o.id],
  );
  const refunds = await many<{ amount_minor: number; status: string; reason: string; created_at: Date }>(
    ctx.pool,
    'SELECT amount_minor, status, reason, created_at FROM refunds WHERE order_id = $1 ORDER BY created_at',
    [o.id],
  );
  const d = await one<{ decided_by: string | null; appeal_reason: string | null }>(ctx.pool, 'SELECT decided_by, appeal_reason FROM disputes WHERE id = $1', [disputeId]);
  return {
    dispute,
    order: {
      id: o.id,
      number: o.number,
      totalMinor: o.total_minor,
      paymentStatus: o.payment_status,
      fulfilmentStatus: o.fulfilment_status,
      buyerName: o.buyer_name,
      shopName: o.shop_name,
      shopSlug: o.shop_slug,
      createdAt: new Date(o.created_at).toISOString(),
    },
    purchased: items.map((i) => {
      const s = i.snapshot as { title?: string; conditionLabel?: string | null; condition?: string | null; flawsDeclaration?: string | null; flaws?: PurchasedItemSnapshot['flaws']; media?: string[] };
      return {
        listingId: i.listing_id,
        title: s.title ?? 'Item',
        conditionLabel: s.conditionLabel ?? s.condition ?? null,
        flawsDeclaration: s.flawsDeclaration ?? null,
        flaws: s.flaws ?? [],
        photoUrls: (s.media ?? []).map((k) => mediaPath(k)),
        version: i.version,
        currentTitle: i.current_title,
        currentCondition: i.current_condition,
        editedAfterPurchase: i.version !== null && i.current_version > i.version,
      };
    }),
    tracking: await orderTracking(ctx, o.id),
    refunds: refunds.map((r) => ({ amountMinor: r.amount_minor, status: r.status, reason: r.reason, createdAt: new Date(r.created_at).toISOString() })),
    refundableMinor: await refundableMinor(ctx.pool, o.id),
    decidedByViewer: d.decided_by === staff.userId,
    appealReason: d.appeal_reason,
  };
}
