import { orderDisputeState, orderTracking, type OrderDetail } from '@thrift/application';
import { formatNaira } from '@thrift/domain';
import { DisputeHeader, DisputeThread } from '@/components/disputes/DisputeThread';
import { TrackingCard } from '@/components/orders/TrackingCard';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { CardSection } from '@/components/ui/Card';
import { TextAreaField, TextField } from '@/components/ui/Field';
import { getCtx } from '@/server/session';
import { AppealForm, MessageForm } from '../../../orders/[id]/dispute-panel';
import { confirmReturnAction, dispatchAction, markDeliveredAction, respondDisputeAction } from './fulfilment-actions';

/** Seller: dispatch per delivery method, tracking, marking delivered, and responding to disputes. */
export async function SellerFulfilmentPanel({ order }: { order: OrderDetail }) {
  if (order.status === 'pending_payment' || order.status === 'cancelled') return null;
  const ctx = await getCtx();
  const [t, ds] = await Promise.all([orderTracking(ctx, order.id), orderDisputeState(ctx, order.id)]);
  if (!t) return null;
  const awaitingDispatch = order.fulfilmentStatus === 'awaiting_dispatch' && ['paid', 'partially_refunded'].includes(order.paymentStatus);
  const canMarkDelivered = t.method !== 'integrated' && !awaitingDispatch && ['in_transit', 'booked', 'exception'].includes(t.status);
  const d = ds.dispute;
  const disputeActive = d && ['awaiting_seller', 'awaiting_buyer', 'under_review', 'appealed'].includes(d.status);
  return (
    <div className="space-y-6">
      {disputeActive && d && (
        <CardSection title="The buyer reported a problem">
          <div className="space-y-4">
            <DisputeHeader d={d} />
            <DisputeThread d={d} />
            {ds.actions.canRespond && (
              <ActionForm action={respondDisputeAction} className="space-y-3 rounded-[var(--radius-card)] bg-sand p-3">
                <input type="hidden" name="disputeId" value={d.id} />
                <fieldset className="space-y-1 text-sm">
                  <legend className="mb-1 font-semibold">Your response</legend>
                  <label className="flex gap-2"><input type="radio" name="response" value="accept_full_refund" /> Refund the buyer in full</label>
                  <label className="flex gap-2"><input type="radio" name="response" value="offer_partial_refund" /> Offer a partial refund</label>
                  <label className="flex gap-2"><input type="radio" name="response" value="reject" defaultChecked /> I disagree — ask support to review</label>
                </fieldset>
                <TextField label="Partial refund (₦)" name="amount" inputMode="numeric" hint={`Up to ${formatNaira(ds.refundableMinor)}.`} />
                <TextAreaField label="Message and explanation" name="message" rows={3} hint="Point to the listing photos or description where relevant." />
                <input type="file" name="photos" multiple accept="image/jpeg,image/png,image/webp" aria-label="Evidence photos" className="block text-sm" />
                <SubmitButton>Send response</SubmitButton>
              </ActionForm>
            )}
            {ds.actions.canConfirmReturn && (
              <ActionForm action={confirmReturnAction}>
                <input type="hidden" name="disputeId" value={d.id} />
                <p className="mb-2 text-sm">Once the returned item reaches you, confirm here to issue the decided refund.</p>
                <SubmitButton variant="secondary">I’ve received the returned item</SubmitButton>
              </ActionForm>
            )}
            {ds.actions.canAddEntry && <MessageForm disputeId={d.id} />}
          </div>
        </CardSection>
      )}
      {d && !disputeActive && ds.actions.canAppeal && (
        <CardSection title="Dispute decision">
          <DisputeHeader d={d} />
          <AppealForm disputeId={d.id} />
        </CardSection>
      )}
      {awaitingDispatch && order.disputeStatus !== 'open' && (
        <CardSection title="Dispatch this order">
          <ActionForm action={dispatchAction} className="space-y-3">
            <input type="hidden" name="orderId" value={order.id} />
            {t.method === 'integrated' ? (
              <p className="text-sm text-muted">The buyer chose the platform courier. Booking creates the courier pickup; milestones then update automatically.</p>
            ) : t.method === 'pickup' ? (
              <p className="text-sm text-muted">The buyer will collect it. Mark it ready, then arrange a time in the order chat. The buyer confirms when they have it.</p>
            ) : (
              <>
                <TextField label="Delivered by (rider or company)" name="carrierName" required />
                <TextField label="Tracking reference (optional)" name="trackingReference" />
                <TextField label="Note for the buyer (optional)" name="note" hint="Don’t include phone numbers — use the order chat." />
                <label className="block text-sm font-medium">
                  Proof photo (optional)
                  <input type="file" name="proof" accept="image/jpeg,image/png,image/webp" className="mt-1 block text-sm" />
                </label>
                <p className="text-xs text-muted">Seller-arranged tracking is labelled “reported by seller”. Your payout is released after the buyer confirms delivery.</p>
              </>
            )}
            <SubmitButton pendingText="Saving…">{t.method === 'integrated' ? 'Book courier' : t.method === 'pickup' ? 'Mark ready for collection' : 'Mark as dispatched'}</SubmitButton>
          </ActionForm>
        </CardSection>
      )}
      {!awaitingDispatch && (
        <TrackingCard t={t}>
          {canMarkDelivered && (
            <ActionForm action={markDeliveredAction}>
              <input type="hidden" name="orderId" value={order.id} />
              <SubmitButton variant="secondary" size="sm">{t.method === 'pickup' ? 'Mark as collected' : 'Mark as delivered'}</SubmitButton>
            </ActionForm>
          )}
          {t.trackingUrl && t.method === 'integrated' && (
            <a href={t.trackingUrl} className="text-sm font-semibold text-primary underline" target="_blank" rel="noreferrer">
              Open courier tracking
            </a>
          )}
        </TrackingCard>
      )}
    </div>
  );
}
