import Link from 'next/link';
import { notFound } from 'next/navigation';
import { staffReviewList } from '@thrift/application';
import { isDomainError } from '@thrift/domain';
import { ReviewCard } from '@/components/trust/ReviewCard';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { Badge } from '@/components/ui/Badge';
import { TextField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { cx } from '@/lib/format';
import { routes, withQuery } from '@/lib/routes';
import { getCtx, requireStaffPage } from '@/server/session';
import { moderateReviewAction } from '../reports/actions';

export const metadata = { title: 'Review moderation' };
export const dynamic = 'force-dynamic';

export default async function ReviewModerationPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  await requireStaffPage(routes.admin.reviews);
  const { status = 'reported' } = await searchParams;
  let reviews;
  try {
    reviews = await staffReviewList(await getCtx(), { status });
  } catch (err) {
    if (isDomainError(err) && err.code === 'FORBIDDEN') notFound();
    throw err;
  }
  return (
    <div className="space-y-5">
      <PageHeader title="Review moderation" description="Hide or remove a review only for a clear policy violation (personal data, hate, off-platform payment requests, unrelated content). Negative experiences stay up." />
      <nav aria-label="Filter reviews" className="flex gap-1">
        {[
          ['reported', 'Reported'],
          ['moderated', 'Hidden/removed'],
          ['all', 'All recent'],
        ].map(([k, label]) => (
          <Link
            key={k}
            href={withQuery(routes.admin.reviews, { status: k })}
            aria-current={status === k ? 'page' : undefined}
            className={cx('inline-flex min-h-10 items-center rounded-lg px-3 text-sm font-semibold', status === k ? 'bg-primary text-white' : 'bg-surface text-ink')}
          >
            {label}
          </Link>
        ))}
      </nav>
      {reviews.length === 0 ? (
        <p className="text-sm text-muted">Nothing here.</p>
      ) : (
        reviews.map((r) => (
          <ReviewCard key={r.id} r={r}>
            <p className="mt-2 text-xs text-muted">
              Shop: {r.shopName} {r.openReports > 0 && <Badge tone="error">{r.openReports} open reports</Badge>}
              {r.moderationReason && ` · Moderation reason: ${r.moderationReason}`}
            </p>
            <ActionForm action={moderateReviewAction} className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end">
              <input type="hidden" name="reviewId" value={r.id} />
              <TextField label="Policy reason" name="reason" required className="flex-1" />
              {r.status === 'published' ? (
                <>
                  <SubmitButton name="action" value="hide" variant="secondary" size="sm">Hide</SubmitButton>
                  <SubmitButton name="action" value="remove" variant="danger" size="sm">Remove</SubmitButton>
                </>
              ) : (
                <SubmitButton name="action" value="restore" size="sm">Restore</SubmitButton>
              )}
            </ActionForm>
          </ReviewCard>
        ))
      )}
    </div>
  );
}
