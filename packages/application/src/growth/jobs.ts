import { registerOutboxHandler } from '../jobs/outbox-dispatcher';
import { registerTask } from '../jobs/tasks';
import { followedDigest, onAuctionScheduled, onBatchDropped } from './fanout';

export function registerGrowthJobs(): void {
  registerOutboxHandler('batch.dropped', async (ctx, ev, tx) => {
    await onBatchDropped(ctx, tx, ev.payload as never);
  });
  registerOutboxHandler('auction.scheduled', async (ctx, ev, tx) => {
    await onAuctionScheduled(ctx, tx, ev.payload as never);
  });
  registerTask({ name: 'growth.followed_digest', intervalMs: 3_600_000, run: (ctx) => followedDigest(ctx) });
}
