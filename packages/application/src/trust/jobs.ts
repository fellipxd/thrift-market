import { maybeOne } from '@thrift/database';
import { registerOutboxHandler } from '../jobs/outbox-dispatcher';
import { registerTask } from '../jobs/tasks';
import { refreshReputations, refreshShopReputation } from './reputation';

export function registerTrustJobs(): void {
  registerTask({ name: 'trust.refresh_reputation', intervalMs: 600_000, run: (ctx) => refreshReputations(ctx) });
  // Event-driven refresh keeps displayed reputation current between periodic runs.
  for (const topic of ['order.delivery_confirmed', 'order.paid']) {
    registerOutboxHandler(topic, async (_ctx, ev, tx) => {
      const orderId = (ev.payload as { orderId?: string }).orderId;
      if (!orderId) return;
      const o = await maybeOne<{ shop_id: string }>(tx, 'SELECT shop_id FROM orders WHERE id = $1', [orderId]);
      if (o) await refreshShopReputation(tx, o.shop_id);
    });
  }
}
