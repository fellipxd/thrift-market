import { dispatchOutbox } from './outbox-dispatcher';
import { registerTask } from './tasks';
import { sendPendingOutboundMessages } from '../notifications/outbound';

/**
 * Explicit registry of background tasks and outbox handlers. Each feature module exports a
 * `register…Jobs()` function and it is called here, so web and worker share one definition.
 */
let registered = false;

export function registerAllJobs(): void {
  if (registered) return;
  registered = true;

  registerTask({ name: 'outbox.dispatch', intervalMs: 2_000, run: (ctx) => dispatchOutbox(ctx) });
  registerTask({ name: 'notifications.send_outbound', intervalMs: 5_000, run: (ctx) => sendPendingOutboundMessages(ctx) });
  registerTask({
    name: 'maintenance.prune',
    intervalMs: 3_600_000,
    run: async (ctx) => {
      const rl = await ctx.pool.query(`DELETE FROM rate_limit_counters WHERE window_start < now() - interval '1 day'`);
      const idem = await ctx.pool.query(`DELETE FROM idempotency_records WHERE created_at < now() - interval '2 days'`);
      const views = await ctx.pool.query(`DELETE FROM listing_view_dedupe WHERE day < current_date - 2`);
      return { rateLimit: rl.rowCount, idempotency: idem.rowCount, viewDedupe: views.rowCount };
    },
  });

  // Feature modules register here (keep one line per module):
}
