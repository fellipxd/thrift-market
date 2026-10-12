import { DomainError, type FulfilmentStatus, type ShipmentStatus } from '@thrift/domain';
import { many, maybeOne, withTransaction } from '@thrift/database';
import { COURIER_SIGNATURE_HEADER, signCourierPayload, type CourierStatus, type CourierTrackingEvent } from '@thrift/providers';
import { recordAudit } from '../core/audit';
import type { AppContext } from '../core/context';
import { addShipmentEvent, afterDeliveryChange, canMoveShipment, lockOrderAndShipment, notifyOrderParty, orderEvent, setFulfilmentStatus } from './shared';

export interface CourierIngestResult {
  accepted: boolean;
  applied: number;
  duplicates: number;
  /** Older than the latest applied milestone: recorded in the history but status not regressed. */
  outOfOrder: number;
  unknown: number;
}

const FULFILMENT_FOR: Partial<Record<CourierStatus, FulfilmentStatus>> = {
  picked_up: 'in_transit',
  in_transit: 'in_transit',
  out_for_delivery: 'in_transit',
  delivered: 'delivered',
  exception: 'delivery_exception',
  returned: 'returned',
};

const STATUS_LABEL: Record<CourierStatus, string> = {
  booked: 'Booked with the courier',
  picked_up: 'Picked up by the courier',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered (courier scan)',
  exception: 'Delivery problem reported by the courier',
  returned: 'Returned to the seller',
  cancelled: 'Courier booking cancelled',
};

/**
 * Courier webhook ingestion: authenticate the raw body, then apply each milestone exactly once (deduplicated by
 * the courier's event id) and only forward — an older event arriving late is kept in the history without
 * regressing the status. A courier "delivered" scan makes delivery courier-verified (payout after the delay);
 * an exception is shown to both parties.
 */
export async function ingestCourierWebhook(ctx: AppContext, rawBody: string, headers: Headers | Record<string, string | undefined>): Promise<CourierIngestResult> {
  const courier = ctx.providers.courier;
  if (rawBody.length > 200_000) throw new DomainError('VALIDATION_FAILED', 'Payload too large.');
  if (!courier.verifyWebhookSignature(rawBody, headers)) {
    await recordAudit(ctx.pool, ctx, { action: 'webhook.signature_rejected', targetKind: 'webhook', targetId: courier.name, data: { bytes: rawBody.length } });
    return { accepted: false, applied: 0, duplicates: 0, outOfOrder: 0, unknown: 0 };
  }
  let events: CourierTrackingEvent[];
  try {
    events = courier.parseWebhook(rawBody);
  } catch {
    throw new DomainError('VALIDATION_FAILED', 'Malformed courier payload.');
  }
  const result: CourierIngestResult = { accepted: true, applied: 0, duplicates: 0, outOfOrder: 0, unknown: 0 };
  for (const e of events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())) {
    const r = await applyCourierEvent(ctx, e);
    result[r]++;
  }
  return result;
}

async function applyCourierEvent(ctx: AppContext, e: CourierTrackingEvent): Promise<'applied' | 'duplicates' | 'outOfOrder' | 'unknown'> {
  const peek = await maybeOne<{ order_id: string }>(ctx.pool, 'SELECT order_id FROM shipments WHERE tracking_reference = $1 AND provider = $2', [
    e.trackingReference,
    ctx.providers.courier.name,
  ]);
  if (!peek) return 'unknown';
  return withTransaction(ctx.pool, async (tx) => {
    const { order, shipment } = await lockOrderAndShipment(tx, peek.order_id);
    const inserted = await addShipmentEvent(tx, {
      shipmentId: shipment.id,
      source: 'courier',
      status: e.status,
      description: e.description || STATUS_LABEL[e.status],
      externalId: e.externalId,
      occurredAt: e.occurredAt,
    });
    if (!inserted) return 'duplicates' as const;
    const target = e.status as ShipmentStatus;
    const stale = shipment.last_event_at !== null && e.occurredAt.getTime() < new Date(shipment.last_event_at).getTime();
    if (stale || !canMoveShipment(shipment.status, target) || ['cancelled', 'returned'].includes(order.fulfilment_status) || order.status === 'cancelled') {
      return 'outOfOrder' as const;
    }
    const confidence = shipment.confidence === 'buyer_confirmed' || shipment.confidence === 'staff_verified' ? shipment.confidence : 'courier_verified';
    await tx.query(
      `UPDATE shipments SET status = $2, confidence = $3, last_event_at = $4, delivered_at = CASE WHEN $2 = 'delivered' THEN coalesce(delivered_at, $4) ELSE delivered_at END,
              updated_at = now() WHERE id = $1`,
      [shipment.id, target, confidence, e.occurredAt],
    );
    const nextFulfilment = FULFILMENT_FOR[e.status];
    if (nextFulfilment && order.fulfilment_status !== nextFulfilment && order.fulfilment_status !== 'delivered') {
      await setFulfilmentStatus(tx, order, nextFulfilment, {
        dispatchedAt: e.occurredAt,
        deliveredAt: nextFulfilment === 'delivered' ? e.occurredAt : undefined,
      });
    }
    if (e.status === 'delivered') {
      await orderEvent(tx, order.id, 'courier_delivered', { kind: 'provider' }, { externalId: e.externalId });
      await afterDeliveryChange(tx, ctx, order.id);
      await notifyOrderParty(tx, order, 'buyer', {
        kind: 'courier_delivered',
        title: `Order ${order.number} was delivered`,
        body: 'The courier recorded the delivery. Confirm you have it, or report a problem within the dispute window.',
        dedupeKey: `courier-delivered:${order.id}`,
      });
    }
    if (e.status === 'exception') {
      await orderEvent(tx, order.id, 'delivery_exception', { kind: 'provider' }, { externalId: e.externalId, description: e.description });
      for (const to of ['buyer', 'seller'] as const) {
        await notifyOrderParty(tx, order, to, {
          kind: 'delivery_exception',
          title: `Delivery problem on order ${order.number}`,
          body: e.description || 'The courier reported a problem. We’ll keep you updated; you can contact support from the order page.',
          dedupeKey: `delivery-exception:${order.id}:${e.externalId}`,
        });
      }
    }
    return 'applied' as const;
  });
}

/**
 * Sandbox only: the courier console emits a milestone for a tracking reference through the same signed webhook
 * ingestion as a real courier.
 */
export async function simulateCourierEvent(
  ctx: AppContext,
  args: { reference: string; status: CourierStatus; description?: string },
): Promise<CourierIngestResult> {
  if (!ctx.providers.courier.isSandbox || ctx.config.env === 'production') throw new DomainError('NOT_FOUND', 'Not available.');
  const allowed: CourierStatus[] = ['picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'exception', 'returned'];
  if (!allowed.includes(args.status)) throw new DomainError('VALIDATION_FAILED', 'Unknown milestone.');
  const body = JSON.stringify({
    events: [
      {
        id: `sim_${args.reference}_${args.status}_${ctx.now().getTime()}`,
        reference: args.reference,
        status: args.status,
        description: args.description ?? '',
        occurred_at: ctx.now().toISOString(),
      },
    ],
  });
  return ingestCourierWebhook(ctx, body, { [COURIER_SIGNATURE_HEADER]: signCourierPayload(ctx.config.appSecret, body) });
}

/** Sandbox console data: the shipment behind a tracking reference and its milestones. */
export async function sandboxCourierShipment(ctx: AppContext, reference: string): Promise<{ reference: string; orderNumber: string; status: string; events: { status: string; at: string; source: string }[] } | null> {
  if (!ctx.providers.courier.isSandbox || ctx.config.env === 'production') return null;
  const s = await maybeOne<{ id: string; status: string; number: string }>(
    ctx.pool,
    `SELECT sh.id, sh.status, o.number FROM shipments sh JOIN orders o ON o.id = sh.order_id WHERE sh.tracking_reference = $1 AND sh.provider = $2`,
    [reference, ctx.providers.courier.name],
  );
  if (!s) return null;
  const events = await many<{ status: string; occurred_at: Date; source: string }>(
    ctx.pool,
    `SELECT status, occurred_at, source FROM shipment_events WHERE shipment_id = $1 ORDER BY occurred_at, id`,
    [s.id],
  );
  return { reference, orderNumber: s.number, status: s.status, events: events.map((e) => ({ status: e.status, at: new Date(e.occurred_at).toISOString(), source: e.source })) };
}
