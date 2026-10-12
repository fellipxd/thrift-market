import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getVerificationCase, hasRole } from '@thrift/application';
import { formatWat, isDomainError, stateLabel } from '@thrift/domain';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Badge } from '@/components/ui/Badge';
import { CardSection } from '@/components/ui/Card';
import { TextAreaField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes } from '@/lib/routes';
import { getCtx, requireStaffPage } from '@/server/session';
import { decideVerificationAction } from '../actions';

export const metadata = { title: 'Verification case' };

export default async function VerificationCasePage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  const user = await requireStaffPage(`${routes.admin.verification}/${caseId}`);
  if (!hasRole(user, 'trust_safety', 'admin')) notFound();
  let c;
  try {
    c = await getVerificationCase(await getCtx(), caseId);
  } catch (err) {
    if (isDomainError(err) && err.code === 'NOT_FOUND') notFound();
    throw err;
  }
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader eyebrow="Verification case" title={c.shop.name} description={`${c.kind} · submitted ${formatWat(c.submittedAt)} by ${c.submittedBy}`} />
      <CardSection title="Submitted details" action={<Badge tone={c.status === 'approved' ? 'success' : c.status === 'rejected' ? 'error' : 'warning'}>{c.status}</Badge>}>
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt className="text-muted">Legal name</dt><dd>{c.legalName}</dd>
          <dt className="text-muted">Document</dt><dd>{c.idTypeLabel ?? '—'}</dd>
          <dt className="text-muted">Number (last 4)</dt><dd>{c.idNumberLast4 ?? '—'}</dd>
          <dt className="text-muted">Shop</dt><dd><Link href={routes.shop(c.shop.slug)} className="underline">{c.shop.name}</Link> · {c.shop.city}, {stateLabel(c.shop.state)}</dd>
          <dt className="text-muted">Account holder</dt><dd>{c.shop.ownerName}{c.shop.contactVerified ? ' · contact verified' : ' · contact NOT verified'}</dd>
        </dl>
      </CardSection>
      <CardSection title="Evidence (restricted)">
        <p className="mb-3 text-xs text-muted">Links expire after a few minutes. This view has been recorded in the audit log.</p>
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {c.evidence.map((e, i) => (
            <li key={e.mediaId}>
              <a href={e.url} target="_blank" rel="noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={e.thumbUrl} alt={`Evidence photo ${i + 1}`} className="aspect-square w-full rounded-lg border border-line object-cover" />
              </a>
            </li>
          ))}
        </ul>
      </CardSection>
      {c.history.length > 1 && (
        <CardSection title="Previous cases">
          <ul className="space-y-1 text-sm">
            {c.history.filter((h) => h.caseId !== c.caseId).map((h) => (
              <li key={h.caseId}>{formatWat(h.submittedAt)} · {h.status}{h.decisionReason ? ` — ${h.decisionReason}` : ''}</li>
            ))}
          </ul>
        </CardSection>
      )}
      {c.canDecide ? (
        <CardSection title="Decision">
          <ActionForm action={decideVerificationAction} className="space-y-3">
            <input type="hidden" name="caseId" value={c.caseId} />
            <TextAreaField label="Reason (required, shown to the seller if rejected)" name="reason" required rows={3} minLength={10} maxLength={1000} />
            <div className="flex gap-2">
              <SubmitButton name="decision" value="approve" pendingText="Saving…">Approve</SubmitButton>
              <SubmitButton name="decision" value="reject" variant="danger" pendingText="Saving…">Reject</SubmitButton>
            </div>
          </ActionForm>
        </CardSection>
      ) : (
        c.decisionReason && <CardSection title="Decision">{c.status} by {c.decidedBy} on {c.decidedAt ? formatWat(c.decidedAt) : '—'}: {c.decisionReason}</CardSection>
      )}
    </div>
  );
}
