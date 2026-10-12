import { DomainError, TRACKING_CONFIDENCE_LABEL, type TrackingConfidence } from '@thrift/domain';
import { many, maybeOne, one } from '@thrift/database';
import { hasRole, requireStaff, requireUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { signMediaUrl } from '../media/media';

const SOURCE_LABEL: Record<string, string> = { courier: 'Courier', seller: 'Seller', buyer: 'Buyer', staff: 'Support', system: 'Thrift Market' };

const EVENT_LABEL: Record<string, string> = {
  booking_requested: 'Courier booking requested',
  booking_failed: 'Courier booking failed — retrying',
  booked: 'Booked with the courier',
  ready_for_pickup: 'Ready for collection',
  picked_up: 'Picked up by the courier',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  exception: 'Delivery problem',
  returned: 'Returned to the seller',
  cancelled: 'Cancelled',
};

export interface OrderTracking {
  orderId: string;
  viewer: 'buyer' | 'seller' | 'staff';
  method: 'integrated' | 'seller_arranged' | 'pickup';
  status: string;
  confidence: TrackingConfidence;
  confidenceLabel: string;
  carrierName: string | null;
  trackingReference: string | null;
  trackingUrl: string | null;
  dispatchBy: string | null;
  dispatchedAt: string | null;
  expectedBy: string | null;
  deliveredAt: string | null;
  lastUpdateAt: string | null;
  exception: boolean;
  late: boolean;
  proofPhoto: { url: string; thumbUrl: string } | null;
  events: { at: string; status: string; label: string; source: string; sourceLabel: string; description: string }[];
  buyerConfirmed: boolean;
  serverNow: string;
}

/** Delivery tracking for the order's buyer, a member of the selling shop, or staff. Milestones — not live GPS. */
export async function orderTracking(ctx: AppContext, orderId: string): Promise<OrderTracking | null> {
  const user = requireUser(ctx);
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) throw new DomainError('NOT_FOUND', 'Order not found.');
  const o = await maybeOne<{ buyer_user_id: string; is_member: boolean; dispatched_at: Date | null; buyer_confirmed_at: Date | null; delivery_method: OrderTracking['method'] }>(
    ctx.pool,
    `SELECT o.buyer_user_id, o.dispatched_at, o.buyer_confirmed_at, o.delivery_method,
            EXISTS (SELECT 1 FROM shop_members m WHERE m.shop_id = o.shop_id AND m.user_id = $2) AS is_member
       FROM orders o WHERE o.id = $1`,
    [orderId, user.userId],
  );
  if (!o) throw new DomainError('NOT_FOUND', 'Order not found.');
  const viewer = o.buyer_user_id === user.userId ? 'buyer' : o.is_member ? 'seller' : hasRole(ctx.actor, 'support', 'trust_safety', 'admin') ? 'staff' : null;
  if (!viewer) throw new DomainError('NOT_FOUND', 'Order not found.');
  const s = await maybeOne<{
    id: string; status: string; confidence: TrackingConfidence; carrier_name: string | null; tracking_reference: string | null; tracking_url: string | null;
    dispatch_by: Date | null; transit_days_max: number | null; delivered_at: Date | null; last_event_at: Date | null; proof_key: string | null;
  }>(
    ctx.pool,
    `SELECT sh.id, sh.status, sh.confidence, sh.carrier_name, sh.tracking_reference, sh.tracking_url, sh.dispatch_by, sh.transit_days_max,
            sh.delivered_at, sh.last_event_at, m.storage_key AS proof_key
       FROM shipments sh LEFT JOIN media_assets m ON m.id = sh.proof_media_id WHERE sh.order_id = $1`,
    [orderId],
  );
  if (!s) return null;
  const events = await many<{ occurred_at: Date; status: string; source: string; description: string }>(
    ctx.pool,
    `SELECT occurred_at, status, source, description FROM shipment_events WHERE shipment_id = $1 ORDER BY occurred_at, id`,
    [s.id],
  );
  const now = ctx.now();
  const base = o.dispatched_at ?? s.dispatch_by;
  const expectedBy = base ? new Date(new Date(base).getTime() + (s.transit_days_max ?? 7) * 86_400_000) : null;
  return {
    orderId,
    viewer,
    method: o.delivery_method,
    status: s.status,
    confidence: s.confidence,
    confidenceLabel: TRACKING_CONFIDENCE_LABEL[s.confidence],
    carrierName: s.carrier_name,
    trackingReference: s.tracking_reference,
    trackingUrl: s.tracking_url,
    dispatchBy: s.dispatch_by ? new Date(s.dispatch_by).toISOString() : null,
    dispatchedAt: o.dispatched_at ? new Date(o.dispatched_at).toISOString() : null,
    expectedBy: expectedBy?.toISOString() ?? null,
    deliveredAt: s.delivered_at ? new Date(s.delivered_at).toISOString() : null,
    lastUpdateAt: s.last_event_at ? new Date(s.last_event_at).toISOString() : null,
    exception: s.status === 'exception',
    late: (!o.dispatched_at && !!s.dispatch_by && now > new Date(s.dispatch_by)) || (s.status !== 'delivered' && !!expectedBy && now > expectedBy),
    proofPhoto: s.proof_key ? { url: signMediaUrl(ctx, s.proof_key, 900), thumbUrl: signMediaUrl(ctx, s.proof_key, 900, 'thumb') } : null,
    events: events
      .filter((e) => viewer !== 'buyer' || !['booking_failed', 'booking_requested'].includes(e.status))
      .map((e) => ({
        at: new Date(e.occurred_at).toISOString(),
        status: e.status,
        label: EVENT_LABEL[e.status] ?? e.status.replace(/_/g, ' '),
        source: e.source,
        sourceLabel: SOURCE_LABEL[e.source] ?? e.source,
        description: e.description,
      })),
    buyerConfirmed: o.buyer_confirmed_at !== null,
    serverNow: now.toISOString(),
  };
}

export interface DeliveryReviewItem {
  orderId: string;
  orderNumber: string;
  shopName: string;
  deliveredAt: string;
  daysSince: number;
  carrierName: string | null;
  trackingReference: string | null;
  hasProof: boolean;
}

/** Staff list: seller-reported deliveries the buyer hasn't confirmed for a long time (no automatic release — D06). */
export async function deliveriesNeedingReview(ctx: AppContext): Promise<DeliveryReviewItem[]> {
  requireStaff(ctx, 'support', 'trust_safety', 'admin');
  const days = (await one<{ v: unknown }>(ctx.pool, `SELECT coalesce((SELECT value FROM platform_settings WHERE key = 'delivery_staff_review_days'), '10'::jsonb) AS v`)).v;
  const rows = await many<{ id: string; number: string; shop_name: string; delivered_at: Date; carrier_name: string | null; tracking_reference: string | null; proof_media_id: string | null }>(
    ctx.pool,
    `SELECT o.id, o.number, s.name AS shop_name, sh.delivered_at, sh.carrier_name, sh.tracking_reference, sh.proof_media_id
       FROM shipments sh JOIN orders o ON o.id = sh.order_id JOIN shops s ON s.id = o.shop_id
      WHERE sh.status = 'delivered' AND sh.confidence = 'seller_reported' AND o.buyer_confirmed_at IS NULL
        AND o.status = 'confirmed' AND o.dispute_status <> 'open' AND sh.delivered_at < $1::timestamptz - ($2 || ' days')::interval
      ORDER BY sh.delivered_at LIMIT 100`,
    [ctx.now(), String(Number(days) || 10)],
  );
  return rows.map((r) => ({
    orderId: r.id,
    orderNumber: r.number,
    shopName: r.shop_name,
    deliveredAt: new Date(r.delivered_at).toISOString(),
    daysSince: Math.floor((ctx.now().getTime() - new Date(r.delivered_at).getTime()) / 86_400_000),
    carrierName: r.carrier_name,
    trackingReference: r.tracking_reference,
    hasProof: r.proof_media_id !== null,
  }));
}
