import { registerOutboxHandler } from '../jobs/outbox-dispatcher';
import { registerTask } from '../jobs/tasks';
import { finalizeDueAuctions, onAuctionOrderPaid, onAuctionReservationReleased, startDueAuctions } from './lifecycle';
import { expireSecondChances } from './second-chance';

export function registerAuctionsJobs(): void {
  registerTask({ name: 'auctions.start_due', intervalMs: 5_000, run: (ctx) => startDueAuctions(ctx) });
  // Short interval: the finaliser is the watchdog that makes ended auctions truthful and allocates the winner.
  registerTask({ name: 'auctions.finalize_due', intervalMs: 2_000, run: (ctx) => finalizeDueAuctions(ctx) });
  registerTask({ name: 'auctions.second_chance_expire', intervalMs: 60_000, run: (ctx) => expireSecondChances(ctx) });
  registerOutboxHandler('reservation.released', (_ctx, ev, tx) => onAuctionReservationReleased(tx, ev.payload as never));
  registerOutboxHandler('order.paid', (_ctx, ev, tx) => onAuctionOrderPaid(tx, ev.payload as never));
}
