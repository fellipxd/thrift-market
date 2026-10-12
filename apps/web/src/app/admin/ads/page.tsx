import Link from 'next/link';
import { notFound } from 'next/navigation';
import { staffPromotionQueue, type StaffPromotionFilter } from '@thrift/application';
import { formatNaira, formatWat, isDomainError } from '@thrift/domain';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Badge } from '@/components/ui/Badge';
import { CardSection } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { SelectField, TextField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { cx } from '@/lib/format';
import { routes, withQuery } from '@/lib/routes';
import { getCtx, requireStaffPage } from '@/server/session';
import { endPromotionAction, requestPromotionRefundAction, reviewPromotionAction } from './actions';

export const metadata = { title: 'Promotions' };
export const dynamic = 'force-dynamic';

const TABS: { key: StaffPromotionFilter; label: string }[] = [
  { key: 'review', label: 'Waiting for review' },
  { key: 'live', label: 'Live' },
  { key: 'ended', label: 'Closed' },
];

export default async function AdminPromotionsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requireStaffPage(routes.admin.ads);
  const sp = await searchParams;
  const tab: StaffPromotionFilter = sp.tab === 'live' || sp.tab === 'ended' ? sp.tab : 'review';
  let rows;
  try {
    rows = await staffPromotionQueue(await getCtx(), tab);
  } catch (err) {
    if (isDomainError(err) && err.code === 'FORBIDDEN') notFound();
    throw err;
  }
  const canReview = user.roles.some((r) => r === 'trust_safety' || r === 'admin');
  return (
    <div className="space-y-5">
      <PageHeader
        title="Promotions"
        description="Paid placements are reviewed before they go live. Rejecting refunds the seller in full. Refunds for unused time after an early stop are requests that a second finance member approves."
      />
      <nav aria-label="Promotion queues" className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={withQuery(routes.admin.ads, { tab: t.key === 'review' ? undefined : t.key })}
            aria-current={tab === t.key ? 'page' : undefined}
            className={cx('rounded-full border px-3 py-1 text-sm', tab === t.key ? 'border-primary bg-primary text-white' : 'border-line-strong bg-surface')}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      <CardSection>
        {rows.length === 0 ? (
          <EmptyState title="Nothing here">No promotions in this queue.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.id} className="space-y-2 py-3 text-sm" data-testid="staff-promotion">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={r.status === 'active' ? 'success' : r.status === 'pending_review' ? 'info' : r.status === 'rejected' ? 'error' : 'neutral'}>{r.status.replace(/_/g, ' ')}</Badge>
                  <span className="font-semibold">{r.packageName}</span>
                  <span>
                    · <Link href={`/shops/${r.shopSlug}`} className="underline">{r.shopName}</Link>
                  </span>
                  {r.listingId && (
                    <span>
                      · <Link href={routes.item(r.listingId)} className="underline">{r.listingTitle}</Link> ({r.listingStatus})
                    </span>
                  )}
                </div>
                <p className="text-muted">
                  {formatNaira(r.priceMinor)} · {r.placementLabel}
                  {r.paidAt && ` · paid ${formatWat(r.paidAt)}`}
                  {r.startsAt && r.endsAt && ` · ${formatWat(r.startsAt)} – ${formatWat(r.endsAt)}`}
                  {r.endedAt && ` · stopped ${formatWat(r.endedAt)}`}
                </p>
                {r.reviewReason && <p>Review note: {r.reviewReason}</p>}
                {r.endReason && <p>End reason: {r.endReason.replace(/_/g, ' ')}</p>}
                {(r.refundMinor > 0 || r.refundOpenMinor > 0) && (
                  <p>
                    Refunded {formatNaira(r.refundMinor)}
                    {r.refundOpenMinor > 0 && ` · ${formatNaira(r.refundOpenMinor)} in progress`}
                  </p>
                )}
                {r.status === 'pending_review' && canReview && (
                  <ActionForm action={reviewPromotionAction} className="grid gap-2 sm:grid-cols-[160px_1fr_auto] sm:items-end">
                    <input type="hidden" name="campaignId" value={r.id} />
                    <SelectField label="Decision" name="decision" required options={[{ value: 'approve', label: 'Approve' }, { value: 'reject', label: 'Reject and refund' }]} />
                    <TextField label="Reason (shared with the seller)" name="reason" required />
                    <SubmitButton size="sm">Apply</SubmitButton>
                  </ActionForm>
                )}
                {r.status === 'active' && canReview && (
                  <ActionForm action={endPromotionAction} className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
                    <input type="hidden" name="campaignId" value={r.id} />
                    <TextField label="Reason to stop (shared with the seller)" name="reason" required />
                    <SubmitButton size="sm" variant="secondary">Stop promotion</SubmitButton>
                  </ActionForm>
                )}
                {r.status === 'ended' && r.unusedMinor > 0 && r.refundOpenMinor === 0 && (
                  <ActionForm action={requestPromotionRefundAction} className="grid gap-2 sm:grid-cols-[160px_1fr_auto] sm:items-end">
                    <input type="hidden" name="campaignId" value={r.id} />
                    <TextField label="Refund (₦)" name="amount" inputMode="decimal" required defaultValue={String(Math.floor(r.unusedMinor / 100))} hint={`Unused time ≈ ${formatNaira(r.unusedMinor)}`} />
                    <TextField label="Why (for the approver)" name="note" required />
                    <SubmitButton size="sm" variant="secondary">Request refund</SubmitButton>
                  </ActionForm>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardSection>
    </div>
  );
}
