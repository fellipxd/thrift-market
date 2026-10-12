import { many, withTransaction } from '@thrift/database';
import type { AppContext } from '../core/context';
import { getSettings } from '../core/settings';
import { registerTask } from '../jobs/tasks';
import { bookCourier } from './commands';
import { notifyOrderParty, orderEvent } from './shared';

/** Worker: retries integrated courier bookings whose provider call failed or timed out. */
export async function retryCourierBookings(ctx: AppContext, batchSize = 20): Promise<{ retried: number; booked: number }> {
  const rows = await many<{ order_id: string }>(
    ctx.pool,
    `SELECT sh.order_id FROM shipments sh JOIN orders o ON o.id = sh.order_id
      WHERE sh.method = 'integrated' AND sh.tracking_reference IS NULL AND sh.status = 'pending'
        AND o.status = 'confirmed' AND o.fulfilment_status = 'awaiting_dispatch'
        AND EXISTS (SELECT 1 FROM shipment_events e WHERE e.shipment_id = sh.id AND e.status = 'booking_requested' AND e.received_at < now() - interval '1 minute')
      ORDER BY sh.updated_at LIMIT $1`,
    [batchSize],
  );
  let booked = 0;
  for (const r of rows) if (await bookCourier(ctx, r.order_id, null)) booked++;
  return { retried: rows.length, booked };
}

/** Worker: paid orders past their dispatch-by time → remind the seller once and record late dispatch. */
export async function dispatchReminders(ctx: AppContext, batchSize = 100): Promise<{ reminded: number }> {
  const rows = await many<{ id: string; number: string; shop_id: string; buyer_user_id: string }>(
    ctx.pool,
    `SELECT o.id, o.number, o.shop_id, o.buyer_user_id FROM orders o JOIN shipments sh ON sh.order_id = o.id
      WHERE o.status = 'confirmed' AND o.fulfilment_status = 'awaiting_dispatch' AND sh.dispatch_by < $1
        AND NOT EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.kind = 'dispatch_late')
      ORDER BY sh.dispatch_by LIMIT $2`,
    [ctx.now(), batchSize],
  );
  for (const o of rows) {
    await withTransaction(ctx.pool, async (tx) => {
      await orderEvent(tx, o.id, 'dispatch_late', { kind: 'system' });
      await notifyOrderParty(tx, o, 'seller', {
        kind: 'dispatch_late',
        title: `Order ${o.number} is late for dispatch`,
        body: 'Dispatch it today or cancel and refund the buyer. Late dispatch affects your service rating.',
        dedupeKey: `dispatch-late:${o.id}`,
      });
    });
  }
  return { reminded: rows.length };
}

/** Worker: seller-reported deliveries without buyer confirmation → remind the buyer, later flag for staff review. */
export async function deliveryFollowups(ctx: AppContext, batchSize = 100): Promise<{ reminded: number; flagged: number }> {
  const settings = await getSettings(ctx.pool);
  const remind = await many<{ id: string; number: string; shop_id: string; buyer_user_id: string }>(
    ctx.pool,
    `SELECT o.id, o.number, o.shop_id, o.buyer_user_id FROM orders o JOIN shipments sh ON sh.order_id = o.id
      WHERE sh.status = 'delivered' AND sh.confidence = 'seller_reported' AND o.buyer_confirmed_at IS NULL AND o.status = 'confirmed'
        AND o.dispute_status <> 'open' AND sh.delivered_at < $1::timestamptz - ($2 || ' days')::interval
        AND NOT EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.kind = 'delivery_confirmation_reminder')
      LIMIT $3`,
    [ctx.now(), String(settings.delivery_confirmation_reminder_days), batchSize],
  );
  for (const o of remind) {
    await withTransaction(ctx.pool, async (tx) => {
      await orderEvent(tx, o.id, 'delivery_confirmation_reminder', { kind: 'system' });
      await notifyOrderParty(tx, o, 'buyer', {
        kind: 'confirm_delivery_reminder',
        title: `Has order ${o.number} arrived?`,
        body: 'The seller says it was delivered. Confirm receipt, or report a problem if it hasn’t arrived or isn’t as described.',
        dedupeKey: `confirm-reminder:${o.id}`,
      });
    });
  }
  const flag = await many<{ id: string }>(
    ctx.pool,
    `SELECT o.id FROM orders o JOIN shipments sh ON sh.order_id = o.id
      WHERE sh.status = 'delivered' AND sh.confidence = 'seller_reported' AND o.buyer_confirmed_at IS NULL AND o.status = 'confirmed'
        AND o.dispute_status <> 'open' AND sh.delivered_at < $1::timestamptz - ($2 || ' days')::interval
        AND NOT EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.kind = 'delivery_review_needed')
      LIMIT $3`,
    [ctx.now(), String(settings.delivery_staff_review_days), batchSize],
  );
  for (const o of flag) await withTransaction(ctx.pool, (tx) => orderEvent(tx, o.id, 'delivery_review_needed', { kind: 'system' }));
  return { reminded: remind.length, flagged: flag.length };
}

export function registerFulfilmentJobs(): void {
  registerTask({ name: 'fulfilment.retry_courier_bookings', intervalMs: 60_000, run: (ctx) => retryCourierBookings(ctx) });
  registerTask({ name: 'fulfilment.dispatch_reminders', intervalMs: 300_000, run: (ctx) => dispatchReminders(ctx) });
  registerTask({ name: 'fulfilment.delivery_followups', intervalMs: 3_600_000, run: (ctx) => deliveryFollowups(ctx) });
}
