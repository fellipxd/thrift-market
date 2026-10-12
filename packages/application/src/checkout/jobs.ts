import { registerTask } from '../jobs/tasks';
import { evaluatePayouts, releasePayouts } from '../payouts/payouts';
import { processRefunds } from '../payments/refunds';
import { processWebhookInbox } from '../payments/webhooks';
import { expireReservations, reconcilePaymentAttempts } from './expiry';

export function registerCheckoutJobs(): void {
  registerTask({ name: 'checkout.expire_reservations', intervalMs: 10_000, run: (ctx) => expireReservations(ctx) });
  registerTask({ name: 'payments.process_webhooks', intervalMs: 5_000, run: (ctx) => processWebhookInbox(ctx) });
  registerTask({ name: 'payments.reconcile_attempts', intervalMs: 60_000, run: (ctx) => reconcilePaymentAttempts(ctx) });
  registerTask({ name: 'payments.process_refunds', intervalMs: 10_000, run: (ctx) => processRefunds(ctx) });
  registerTask({ name: 'payouts.evaluate', intervalMs: 60_000, run: (ctx) => evaluatePayouts(ctx) });
  registerTask({ name: 'payouts.release', intervalMs: 60_000, run: (ctx) => releasePayouts(ctx) });
}
