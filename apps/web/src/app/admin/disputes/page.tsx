import Link from 'next/link';
import { notFound } from 'next/navigation';
import { deliveriesNeedingReview, staffDisputeQueue } from '@thrift/application';
import { formatNaira, formatWat, isDomainError } from '@thrift/domain';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Badge } from '@/components/ui/Badge';
import { CardSection } from '@/components/ui/Card';
import { TextField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { cx } from '@/lib/format';
import { routes, withQuery } from '@/lib/routes';
import { getCtx, requireUserPage } from '@/server/session';
import { staffVerifyDeliveryAction } from './actions';

export const metadata = { title: 'Disputes' };
export const dynamic = 'force-dynamic';

export default async function DisputesQueuePage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  await requireUserPage(routes.admin.disputes);
  const { status = 'open' } = await searchParams;
  const ctx = await getCtx();
  let queue, deliveries;
  try {
    [queue, deliveries] = await Promise.all([staffDisputeQueue(ctx, { status }), deliveriesNeedingReview(ctx)]);
  } catch (err) {
    if (isDomainError(err) && err.code === 'FORBIDDEN') notFound();
    throw err;
  }
  return (
    <div className="space-y-6">
      <PageHeader title="Disputes" description="Appeals and reviews first. Compare each claim with the listing as purchased before deciding." />
      <nav aria-label="Filter disputes" className="flex gap-1">
        {['open', 'closed', 'all'].map((s) => (
          <Link
            key={s}
            href={withQuery(routes.admin.disputes, { status: s === 'open' ? undefined : s })}
            aria-current={status === s ? 'page' : undefined}
            className={cx('inline-flex min-h-10 items-center rounded-lg px-3 text-sm font-semibold capitalize', status === s ? 'bg-primary text-white' : 'bg-surface text-ink')}
          >
            {s}
          </Link>
        ))}
      </nav>
      <CardSection title={`Disputes (${queue.length})`}>
        {queue.length === 0 ? (
          <p className="text-sm text-muted">Nothing here.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {queue.map((d) => (
              <li key={d.id}>
                <Link href={routes.admin.dispute(d.id)} className="flex flex-wrap items-center justify-between gap-2 py-2 hover:bg-primary-soft/40">
                  <span>
                    <span className="font-semibold">{d.orderNumber}</span> · {d.reasonLabel} · {d.shopName}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="text-muted">{formatNaira(d.totalMinor)}</span>
                    <Badge tone={d.status === 'appealed' || d.overdue ? 'error' : d.status === 'under_review' ? 'warning' : 'neutral'}>{d.statusLabel}</Badge>
                    {d.overdue && <Badge tone="error">Overdue</Badge>}
                  </span>
                  <span className="w-full text-xs text-muted">Opened {formatWat(d.createdAt)}{d.respondBy ? ` · response due ${formatWat(d.respondBy)}` : ''}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardSection>
      <CardSection title={`Deliveries needing review (${deliveries.length})`}>
        <p className="mb-3 text-sm text-muted">Seller-reported deliveries the buyer hasn’t confirmed for a long time. Payouts are never released on buyer silence alone — verify with evidence (proof photo, rider records, contact with the buyer).</p>
        {deliveries.length === 0 ? (
          <p className="text-sm text-muted">None.</p>
        ) : (
          <ul className="space-y-3">
            {deliveries.map((d) => (
              <li key={d.orderId} className="rounded-[var(--radius-card)] border border-line p-3 text-sm">
                <p>
                  <span className="font-semibold">{d.orderNumber}</span> · {d.shopName} · reported delivered {d.daysSince} days ago
                  {d.carrierName && ` · ${d.carrierName}`}
                  {d.trackingReference && ` · ref ${d.trackingReference}`}
                  {d.hasProof ? ' · proof photo attached' : ' · no proof photo'}
                </p>
                <ActionForm action={staffVerifyDeliveryAction} className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end">
                  <input type="hidden" name="orderId" value={d.orderId} />
                  <TextField label="Evidence relied on" name="reason" required className="flex-1" />
                  <SubmitButton size="sm">Verify delivery</SubmitButton>
                </ActionForm>
              </li>
            ))}
          </ul>
        )}
      </CardSection>
    </div>
  );
}
