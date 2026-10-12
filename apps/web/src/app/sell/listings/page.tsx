import Link from 'next/link';
import { redirect } from 'next/navigation';
import { findOwnShop, sellerListings, type SellerListingFilter } from '@thrift/application';
import { formatNaira } from '@thrift/domain';
import { ListingStatusBadge } from '@/components/catalogue/ListingStatusBadge';
import { ActionForm, SubmitButton } from '@/components/ui/ActionForm';
import { ButtonLink } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Photo } from '@/components/ui/Photo';
import { cx } from '@/lib/format';
import { routes, withQuery } from '@/lib/routes';
import { services } from '@/server/services';
import { getCtx, requireUserPage } from '@/server/session';
import { bulkAction } from './actions';

export const metadata = { title: 'Listings' };

const TABS: { key: SellerListingFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Drafts' },
  { key: 'active', label: 'Available' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'reserved', label: 'Reserved' },
  { key: 'paused', label: 'Paused' },
  { key: 'sold', label: 'Sold' },
  { key: 'ended', label: 'Ended' },
];

export default async function ListingsPage({ searchParams }: { searchParams: Promise<{ status?: string; q?: string; cursor?: string }> }) {
  const user = await requireUserPage(routes.sell.listings);
  if (!(await findOwnShop(services().pool, user.userId))) redirect(routes.sell.onboarding);
  const sp = await searchParams;
  const page = await sellerListings(await getCtx(), { status: sp.status, q: sp.q, cursor: sp.cursor });
  const active = (TABS.find((t) => t.key === sp.status)?.key ?? 'all') as SellerListingFilter;
  return (
    <div className="space-y-5">
      <PageHeader title="Listings" actions={<ButtonLink href={routes.sell.newListing}>Add an item</ButtonLink>} />
      <nav aria-label="Filter listings" className="-mx-1 overflow-x-auto">
        <ul className="flex gap-1 px-1 pb-1">
          {TABS.map((t) => (
            <li key={t.key}>
              <Link
                href={withQuery(routes.sell.listings, { status: t.key === 'all' ? undefined : t.key, q: sp.q })}
                aria-current={active === t.key ? 'page' : undefined}
                className={cx('inline-flex min-h-10 items-center whitespace-nowrap rounded-lg px-3 text-sm font-semibold', active === t.key ? 'bg-primary text-white' : 'bg-surface text-ink')}
              >
                {t.label} <span className="ml-1 opacity-80">{page.counts[t.key]}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <form method="get" className="flex gap-2" role="search">
        {sp.status && <input type="hidden" name="status" value={sp.status} />}
        <label htmlFor="listing-q" className="sr-only">Search your listings</label>
        <input id="listing-q" name="q" defaultValue={sp.q} placeholder="Search by title" className="w-full max-w-sm rounded-[var(--radius-control)] border border-line-strong bg-surface px-3 py-2" />
        <button className="min-h-11 rounded-[var(--radius-control)] border-2 border-primary px-4 font-semibold text-primary">Search</button>
      </form>
      {page.rows.length === 0 ? (
        <EmptyState title={sp.q ? 'No listings match' : 'No listings here yet'} action={<ButtonLink href={routes.sell.newListing}>List a piece</ButtonLink>}>
          Photograph the actual piece, choose its condition grade, and describe any flaws — it saves you repeated questions later.
        </EmptyState>
      ) : (
        <ActionForm action={bulkAction} className="space-y-3">
          <div className="flex flex-wrap items-end gap-2 rounded-[var(--radius-card)] bg-surface p-3">
            <label className="text-sm">
              <span className="mb-1 block font-semibold">With selected</span>
              <select name="action" className="rounded-[var(--radius-control)] border border-line-strong bg-surface px-3 py-2" defaultValue="pause">
                <option value="pause">Pause</option>
                <option value="resume">Resume</option>
                <option value="mark_sold_elsewhere">Mark sold elsewhere (1 unit each)</option>
              </select>
            </label>
            <SubmitButton variant="secondary" pendingText="Applying…">Apply</SubmitButton>
          </div>
          <ul className="divide-y divide-line overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
            {page.rows.map((r) => (
              <li key={r.id} className="flex items-center gap-3 p-3">
                <input type="checkbox" name="listingIds" value={r.id} aria-label={`Select ${r.title}`} className="size-5 shrink-0 accent-[var(--color-primary)]" />
                <Photo storageKey={r.photoKey} alt="" className="size-14 shrink-0 rounded-lg" />
                <div className="min-w-0 flex-1">
                  <Link href={routes.sell.listing(r.id)} className="line-clamp-1 font-medium hover:underline">{r.title}</Link>
                  <p className="text-xs text-muted">
                    {r.saleModeLabel}
                    {r.priceMinor ? ` · ${formatNaira(r.priceMinor)}` : ''}
                    {r.quantityMode === 'equivalent' && r.quantityTotal !== null ? ` · ${r.quantityAvailable}/${r.quantityTotal} units available` : ''}
                    {r.batchName ? ` · ${r.batchName}` : ''}
                  </p>
                  <p className="text-xs text-muted">{r.views30d} views (30 days) · {r.saves} saves</p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <ListingStatusBadge status={r.status} label={r.statusLabel} />
                  {r.auctionId && <Link href={routes.auction(r.auctionId)} className="text-xs font-semibold text-primary underline">Auction</Link>}
                </div>
              </li>
            ))}
          </ul>
        </ActionForm>
      )}
      {page.nextCursor && (
        <div className="flex justify-center">
          <ButtonLink variant="secondary" href={withQuery(routes.sell.listings, { status: sp.status, q: sp.q, cursor: page.nextCursor })}>Load more</ButtonLink>
        </div>
      )}
    </div>
  );
}
