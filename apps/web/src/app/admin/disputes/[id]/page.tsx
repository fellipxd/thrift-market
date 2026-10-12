import Link from 'next/link';
import { notFound } from 'next/navigation';
import { staffDisputeDetail, type StaffDisputeDetail } from '@thrift/application';
import { formatNaira, formatWat, isDomainError } from '@thrift/domain';
import { DisputeHeader, DisputeThread } from '@/components/disputes/DisputeThread';
import { TrackingCard } from '@/components/orders/TrackingCard';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Alert } from '@/components/ui/Alert';
import { Card, CardSection } from '@/components/ui/Card';
import { SelectField, TextAreaField, TextField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes } from '@/lib/routes';
import { getCtx, requireStaffPage } from '@/server/session';
import { decideDisputeAction, staffConfirmReturnAction, staffNoteAction } from '../actions';

export const metadata = { title: 'Dispute' };
export const dynamic = 'force-dynamic';

export default async function DisputeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireStaffPage(routes.admin.dispute(id));
  let x: StaffDisputeDetail;
  try {
    x = await staffDisputeDetail(await getCtx(), id);
  } catch (err) {
    if (isDomainError(err) && (err.code === 'NOT_FOUND' || err.code === 'FORBIDDEN')) notFound();
    throw err;
  }
  const d = x.dispute;
  const decidable = d.status === 'under_review' || d.status === 'appealed';
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={`Order ${x.order.number}`} title={d.reasonLabel} description={`Buyer ${x.order.buyerName} · Shop ${x.order.shopName} · paid ${formatNaira(x.order.totalMinor)} · ${x.order.paymentStatus}`} />
      <div className="grid gap-6 xl:grid-cols-2">
        <CardSection title="As purchased (immutable snapshot)">
          {x.purchased.map((p) => (
            <div key={p.listingId} className="space-y-2 text-sm">
              <p className="font-semibold">{p.title}</p>
              <p>
                Condition: <strong>{p.conditionLabel ?? '—'}</strong>
                {p.version !== null && <span className="text-muted"> · listing version {p.version}</span>}
              </p>
              {p.flaws.length > 0 ? (
                <ul className="list-disc pl-5">
                  {p.flaws.map((f, i) => (
                    <li key={i}>
                      {f.description}
                      {f.location ? ` (${f.location})` : ''}
                      {f.severity ? ` — ${f.severity}` : ''}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted">{p.flawsDeclaration === 'none_known' ? 'Seller declared no known flaws.' : 'No flaws recorded.'}</p>
              )}
              <div className="flex flex-wrap gap-2">
                {p.photoUrls.map((u, i) => (
                  <a key={u} href={u} target="_blank" rel="noreferrer">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`${u}.thumb`} alt={`Purchased listing photo ${i + 1}`} className="h-24 w-20 rounded-md object-cover" />
                  </a>
                ))}
              </div>
              {p.editedAfterPurchase && (
                <Alert tone="warning">
                  The seller edited this listing after the sale (now “{p.currentTitle}”, condition {p.currentCondition ?? '—'}). Decide against the snapshot above.
                </Alert>
              )}
            </div>
          ))}
        </CardSection>
        <CardSection title="Claim and evidence">
          <div className="space-y-4">
            <DisputeHeader d={d} />
            {x.appealReason && <Alert tone="warning" title="Appeal">{x.appealReason}</Alert>}
            <DisputeThread d={d} />
          </div>
        </CardSection>
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        {x.tracking ? <TrackingCard t={x.tracking} /> : <Card className="p-4 text-sm text-muted">No shipment recorded.</Card>}
        <CardSection title="Money">
          <p className="text-sm">Still refundable: <strong>{formatNaira(x.refundableMinor)}</strong></p>
          {x.refunds.length > 0 && (
            <ul className="mt-2 text-sm text-muted">
              {x.refunds.map((r, i) => (
                <li key={i}>
                  {formatNaira(r.amountMinor)} · {r.reason.replace(/_/g, ' ')} · {r.status} · {formatWat(r.createdAt)}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-muted">Refunds always go through the payments module and are confirmed by the provider.</p>
          <Link href={routes.order(x.order.id)} className="mt-2 inline-block text-sm underline">Order page</Link>
        </CardSection>
      </div>
      {decidable && (
        <CardSection title={d.status === 'appealed' ? 'Decide the appeal' : 'Decision'}>
          {d.status === 'appealed' && x.decidedByViewer ? (
            <Alert tone="info">You made the original decision. A different team member must decide the appeal.</Alert>
          ) : (
            <ActionForm action={decideDisputeAction} className="grid gap-3 sm:grid-cols-2">
              <input type="hidden" name="disputeId" value={d.id} />
              <SelectField
                label="Outcome"
                name="outcome"
                required
                placeholder="Choose an outcome"
                options={[
                  { value: 'full_refund', label: 'Full refund' },
                  { value: 'partial_refund', label: 'Partial refund' },
                  ...(d.status === 'appealed' ? [] : [{ value: 'return_and_refund', label: 'Return item, then refund' }]),
                  { value: 'no_refund', label: 'No refund' },
                ]}
              />
              <TextField label="Refund amount (₦, partial or return)" name="refundAmount" inputMode="numeric" hint={`At most ${formatNaira(x.refundableMinor)}.`} />
              <TextAreaField label="Reason (shared with both parties)" name="reason" required rows={3} className="sm:col-span-2" />
              <TextAreaField label="Return instructions (return and refund only)" name="returnInstructions" rows={2} className="sm:col-span-2" />
              <div className="sm:col-span-2">
                <SubmitButton>Record decision</SubmitButton>
              </div>
            </ActionForm>
          )}
        </CardSection>
      )}
      {d.status === 'awaiting_seller' && d.outcome === 'return_and_refund' && (
        <CardSection title="Return in progress">
          <ActionForm action={staffConfirmReturnAction}>
            <input type="hidden" name="disputeId" value={d.id} />
            <p className="mb-2 text-sm text-muted">If the seller can’t confirm (e.g. courier proof of return delivery), support can confirm it. This is audited.</p>
            <SubmitButton variant="secondary">Confirm return received</SubmitButton>
          </ActionForm>
        </CardSection>
      )}
      {['awaiting_seller', 'awaiting_buyer', 'under_review', 'appealed'].includes(d.status) && (
        <CardSection title="Add a note">
          <ActionForm action={staffNoteAction} resetOnSuccess className="space-y-2">
            <input type="hidden" name="disputeId" value={d.id} />
            <TextAreaField label="Message" name="body" required rows={2} />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="internal" defaultChecked /> Internal note (not shown to buyer or seller)
            </label>
            <SubmitButton variant="secondary" size="sm">Add</SubmitButton>
          </ActionForm>
        </CardSection>
      )}
    </div>
  );
}
