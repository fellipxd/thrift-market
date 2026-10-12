import { orderTracking, type OrderDetail } from '@thrift/application';
import { TrackingCard } from '@/components/orders/TrackingCard';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { getCtx } from '@/server/session';
import { confirmReceiptAction } from './actions';

/** Buyer: delivery tracking with confidence labels, and confirming receipt (the strongest delivery signal). */
export async function OrderFulfilmentPanel({ order }: { order: OrderDetail }) {
  if (order.status === 'pending_payment' || order.status === 'cancelled') return null;
  const t = await orderTracking(await getCtx(), order.id);
  if (!t) return null;
  const canConfirm =
    !t.buyerConfirmed &&
    order.disputeStatus !== 'open' &&
    ['paid', 'partially_refunded'].includes(order.paymentStatus) &&
    (order.fulfilmentStatus !== 'awaiting_dispatch' || t.method === 'pickup') &&
    !['returned', 'cancelled'].includes(order.fulfilmentStatus);
  return (
    <TrackingCard t={t}>
      {canConfirm && (
        <ActionForm action={confirmReceiptAction} className="rounded-[var(--radius-card)] bg-primary-soft p-3">
          <input type="hidden" name="orderId" value={order.id} />
          <p className="mb-2 text-sm">
            {t.method === 'pickup' ? 'Collected it? ' : 'Got it? '}Confirm once you have the item and it’s as described. This releases the seller’s payout, so don’t confirm if
            something is wrong — report a problem below instead.
          </p>
          <SubmitButton pendingText="Confirming…">I have received it</SubmitButton>
        </ActionForm>
      )}
      {t.buyerConfirmed && <p className="text-sm font-semibold text-success">You confirmed you received this order.</p>}
    </TrackingCard>
  );
}
