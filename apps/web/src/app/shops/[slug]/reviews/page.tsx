import Link from 'next/link';
import { notFound } from 'next/navigation';
import { shopReviews, type ShopReviewsPage } from '@thrift/application';
import { isDomainError } from '@thrift/domain';
import { ReviewCard } from '@/components/trust/ReviewCard';
import { Stars } from '@/components/trust/Stars';
import { Badge } from '@/components/ui/Badge';
import { ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes, withQuery } from '@/lib/routes';
import { getCtx } from '@/server/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  return { title: `Reviews · ${(await params).slug}` };
}

export default async function ShopReviewsRoute({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ cursor?: string }> }) {
  const { slug } = await params;
  const { cursor } = await searchParams;
  let page: ShopReviewsPage;
  try {
    page = await shopReviews(await getCtx(), slug, { cursor });
  } catch (err) {
    if (isDomainError(err) && err.code === 'NOT_FOUND') notFound();
    throw err;
  }
  const s = page.summary;
  const dims: [string, number | null][] = [
    ['Condition as described', s.averages.accuracy],
    ['Communication', s.averages.communication],
    ['Delivery', s.averages.delivery],
  ];
  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <PageHeader eyebrow={<Link href={routes.shop(page.shop.slug)} className="underline">{page.shop.name}</Link>} title="Reviews" description="Only buyers who received an order can review it." />
      <Card className="mb-6 space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          {s.averages.overall !== null ? (
            <>
              <span className="text-4xl font-semibold tabular-nums">{s.averages.overall.toFixed(1)}</span>
              <Stars value={s.averages.overall} label="Average rating" />
            </>
          ) : (
            <span className="text-muted">No reviews yet</span>
          )}
          <Badge tone={s.isNew ? 'neutral' : s.tier === 'under_review' ? 'warning' : 'success'}>{s.tierLabel}</Badge>
        </div>
        <p className="text-sm text-muted">{s.sampleText}{s.isNew && ' — too few orders to judge service yet.'}</p>
        {s.count > 0 && (
          <dl className="grid gap-1 text-sm sm:grid-cols-3">
            {dims.map(([label, v]) => (
              <div key={label}>
                <dt className="text-muted">{label}</dt>
                <dd className="font-semibold">{v?.toFixed(1) ?? '—'} / 5</dd>
              </div>
            ))}
          </dl>
        )}
      </Card>
      {page.reviews.length === 0 ? (
        <EmptyState title="No reviews yet">Reviews appear after buyers receive their orders.</EmptyState>
      ) : (
        <div className="space-y-3">
          {page.reviews.map((r) => (
            <ReviewCard key={r.id} r={r}>
              <Link href={routes.report('review', r.id)} className="mt-2 inline-block text-xs text-muted underline">Report review</Link>
            </ReviewCard>
          ))}
          {page.nextCursor && (
            <div className="flex justify-center">
              <ButtonLink href={withQuery(routes.shopReviews(page.shop.slug), { cursor: page.nextCursor })} variant="secondary">More reviews</ButtonLink>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
