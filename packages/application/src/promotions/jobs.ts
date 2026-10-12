import { many, withTransaction } from '@thrift/database';
import type { AppContext } from '../core/context';
import { getSettings } from '../core/settings';
import { registerTask } from '../jobs/tasks';
import { registerPaymentPurposeHandler } from '../payments/apply';
import { applyPromotionPayment } from './campaigns';
import { lockCampaign, notifyShopOwner } from './shared';

/**
 * Promotion lifecycle upkeep (idempotent; safe to run from several workers):
 * - scheduled promotions go live at their start, live ones finish at their scheduled end;
 * - a promoted item that is sold, ended or removed stops its promotion (it already left the placement the moment
 *   it became unavailable); unused time is not refunded automatically while that policy is open (D10);
 * - bookings still unpaid after the payment window lapse (a payment that arrives later is refunded in full).
 */
export async function maintainPromotions(ctx: AppContext): Promise<{ started: number; finished: number; stopped: number; lapsed: number }> {
  const settings = await getSettings(ctx.pool);
  const started = await ctx.pool.query(`UPDATE ad_campaigns SET status = 'active', updated_at = now() WHERE status = 'scheduled' AND starts_at <= now() AND ends_at > now()`);

  const due = await many<{ id: string }>(ctx.pool, `SELECT id FROM ad_campaigns WHERE status IN ('scheduled','active','paused') AND ends_at <= now() LIMIT 200`);
  let finished = 0;
  for (const { id } of due) {
    await withTransaction(ctx.pool, async (tx) => {
      const c = await lockCampaign(tx, id);
      if (!['scheduled', 'active', 'paused'].includes(c.status) || !c.ends_at || new Date(c.ends_at) > ctx.now()) return;
      await tx.query(`UPDATE ad_campaigns SET status = 'ended', ended_at = ends_at, end_reason = 'completed', updated_at = now() WHERE id = $1`, [id]);
      await notifyShopOwner(tx, c.shop_id, {
        kind: 'promotion_finished',
        title: 'Your promotion has finished',
        body: 'See how it did on your promotions page.',
        dedupeKey: `promotion-finished:${id}`,
      });
      finished++;
    });
  }

  const unavailable = await many<{ id: string }>(
    ctx.pool,
    `SELECT c.id FROM ad_campaigns c JOIN listings l ON l.id = c.listing_id
      WHERE c.target_kind = 'listing' AND c.status IN ('scheduled','active','paused') AND l.status IN ('sold','ended','removed') LIMIT 200`,
  );
  let stopped = 0;
  for (const { id } of unavailable) {
    await withTransaction(ctx.pool, async (tx) => {
      const c = await lockCampaign(tx, id);
      if (!['scheduled', 'active', 'paused'].includes(c.status)) return;
      await tx.query(`UPDATE ad_campaigns SET status = 'ended', ended_at = least(now(), ends_at), end_reason = 'listing_unavailable', updated_at = now() WHERE id = $1`, [id]);
      await notifyShopOwner(tx, c.shop_id, {
        kind: 'promotion_stopped',
        title: 'Your promotion stopped: the item is no longer for sale',
        body: 'Sold or ended items leave promoted placements straight away. Unused time isn’t refunded automatically — contact support if you have questions.',
        dedupeKey: `promotion-unavailable:${id}`,
      });
      stopped++;
    });
  }

  const lapsed = await ctx.pool.query(
    `UPDATE ad_campaigns c SET status = 'cancelled', end_reason = 'payment_not_completed', updated_at = now()
      WHERE c.status = 'awaiting_payment' AND c.created_at < now() - make_interval(hours => $1)
        AND NOT EXISTS (SELECT 1 FROM payment_attempts pa WHERE pa.ad_campaign_id = c.id AND pa.status IN ('initiated','pending','uncertain')
                          AND pa.created_at > now() - make_interval(hours => $1))`,
    [settings.promotion_payment_window_hours],
  );
  return { started: started.rowCount ?? 0, finished, stopped, lapsed: lapsed.rowCount ?? 0 };
}

export function registerPromotionsJobs(): void {
  registerPaymentPurposeHandler('ad_campaign', applyPromotionPayment);
  registerTask({ name: 'promotions.maintain', intervalMs: 60_000, run: (ctx) => maintainPromotions(ctx) });
}
