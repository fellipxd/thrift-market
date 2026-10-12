import { savedItems } from '@thrift/application';
import { ButtonLink } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ListingGrid } from '@/components/ui/ListingCard';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes, withQuery } from '@/lib/routes';
import { getCtx, requireUserPage } from '@/server/session';

export const metadata = { title: 'Saved' };

export default async function SavedPage({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  await requireUserPage(routes.saved);
  const { cursor } = await searchParams;
  const res = await savedItems(await getCtx(), { cursor });
  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <PageHeader title="Saved" description="Pieces you’re keeping an eye on. Saving doesn’t reserve an item." />
      {res.available.length === 0 && res.unavailable.length === 0 ? (
        <EmptyState title="Nothing saved yet" action={<ButtonLink href={routes.search()}>Start browsing</ButtonLink>}>
          Tap ♡ Save on any piece to find it here later.
        </EmptyState>
      ) : (
        <>
          <ListingGrid items={res.available} emptyText="None of your saved pieces are available right now." />
          {res.nextCursor && (
            <div className="mt-8 flex justify-center">
              <ButtonLink href={withQuery(routes.saved, { cursor: res.nextCursor })} variant="secondary">Load more</ButtonLink>
            </div>
          )}
          {res.unavailable.length > 0 && (
            <section className="mt-12" aria-labelledby="gone-h">
              <h2 id="gone-h" className="mb-4 text-lg font-semibold text-muted">No longer available ({res.unavailableCount})</h2>
              <ul className="grid grid-cols-2 gap-3 opacity-80 sm:grid-cols-3 lg:grid-cols-5">
                {res.unavailable.map((i) => (
                  <li key={i.id} className="rounded-[var(--radius-card)] border border-line bg-surface p-3 text-sm">
                    <p className="line-clamp-1 font-medium">{i.title}</p>
                    <p className="text-muted">{i.unavailableLabel}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
