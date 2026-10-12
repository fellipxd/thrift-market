import { orderDisputeState, type OrderDetail } from '@thrift/application';
import { formatNaira, formatWat } from '@thrift/domain';
import { DisputeHeader, DisputeThread } from '@/components/disputes/DisputeThread';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { CardSection } from '@/components/ui/Card';
import { SelectField, TextAreaField } from '@/components/ui/Field';
import { getCtx } from '@/server/session';
import { appealDisputeAction, disputeMessageAction, openDisputeAction, partialOfferAction, withdrawDisputeAction } from './actions';

/** Buyer: report a problem (within the allowed window) and follow the dispute. */
export async function OrderDisputePanel({ order }: { order: OrderDetail }) {
  if (order.status === 'pending_payment' || order.status === 'cancelled') return null;
  const s = await orderDisputeState(await getCtx(), order.id);
  const d = s.dispute;
  const active = d && ['awaiting_seller', 'awaiting_buyer', 'under_review', 'appealed'].includes(d.status);
  if (!d || !active) {
    if (!s.eligibility) return null;
    return (
      <CardSection title="Something wrong?">
        {d && (
          <div className="mb-4">
            <DisputeHeader d={d} />
            {s.actions.canAppeal && <AppealForm disputeId={d.id} />}
          </div>
        )}
        {s.eligibility.reasons.length === 0 ? (
          <p className="text-sm text-muted">{s.eligibility.blockedReason}</p>
        ) : (
          <ActionForm action={openDisputeAction} className="space-y-3">
            <input type="hidden" name="orderId" value={order.id} />
            <p className="text-sm text-muted">
              Your payment is held while we sort it out.
              {s.eligibility.windowEndsAt && ` You can report a problem until ${formatWat(s.eligibility.windowEndsAt)}.`}
            </p>
            <SelectField label="What went wrong?" name="reason" required placeholder="Choose a reason" options={s.eligibility.reasons} />
            <TextAreaField label="Describe the problem" name="description" required rows={4} hint="Compare with the listing as you bought it: condition, flaws, size, photos." />
            <label className="block text-sm font-medium">
              Photos (up to 6)
              <input type="file" name="photos" multiple accept="image/jpeg,image/png,image/webp" className="mt-1 block text-sm" />
            </label>
            <SubmitButton variant="secondary" pendingText="Sending…">Report a problem</SubmitButton>
          </ActionForm>
        )}
      </CardSection>
    );
  }
  return (
    <CardSection title="Your reported problem">
      <div className="space-y-4">
        <DisputeHeader d={d} />
        {s.actions.canAnswerOffer && d.refundAmountMinor && (
          <ActionForm action={partialOfferAction} className="rounded-[var(--radius-card)] bg-primary-soft p-3">
            <input type="hidden" name="disputeId" value={d.id} />
            <p className="mb-2 text-sm">The seller offered {formatNaira(d.refundAmountMinor)} back. Accept, or ask support to review.</p>
            <div className="flex flex-wrap gap-2">
              <SubmitButton name="decision" value="accept" size="sm">Accept {formatNaira(d.refundAmountMinor)}</SubmitButton>
              <SubmitButton name="decision" value="escalate" variant="secondary" size="sm">Ask support to review</SubmitButton>
            </div>
          </ActionForm>
        )}
        {d.outcome === 'return_and_refund' && d.status === 'awaiting_seller' && (
          <p className="rounded-md bg-warning-soft p-3 text-sm">Return the item as instructed below. Your refund is issued once the seller (or support) confirms it’s back.</p>
        )}
        <DisputeThread d={d} />
        {s.actions.canAddEntry && <MessageForm disputeId={d.id} />}
        {s.actions.canWithdraw && (
          <ActionForm action={withdrawDisputeAction}>
            <input type="hidden" name="disputeId" value={d.id} />
            <SubmitButton variant="ghost" size="sm">Withdraw — everything is fine now</SubmitButton>
          </ActionForm>
        )}
      </div>
    </CardSection>
  );
}

export function MessageForm({ disputeId, action = disputeMessageAction }: { disputeId: string; action?: typeof disputeMessageAction }) {
  return (
    <ActionForm action={action} resetOnSuccess className="space-y-2">
      <input type="hidden" name="disputeId" value={disputeId} />
      <TextAreaField label="Add a message or evidence" name="body" rows={2} required />
      <input type="file" name="photos" multiple accept="image/jpeg,image/png,image/webp" aria-label="Evidence photos" className="block text-sm" />
      <SubmitButton variant="secondary" size="sm">Send</SubmitButton>
    </ActionForm>
  );
}

export function AppealForm({ disputeId }: { disputeId: string }) {
  return (
    <ActionForm action={appealDisputeAction} className="mt-3 space-y-2">
      <input type="hidden" name="disputeId" value={disputeId} />
      <TextAreaField label="Appeal this decision (once)" name="reason" rows={2} required hint="A different support team member will review it." />
      <SubmitButton variant="secondary" size="sm">Appeal</SubmitButton>
    </ActionForm>
  );
}
