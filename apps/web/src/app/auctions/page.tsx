import { listAuctions } from '@thrift/application';
import { ButtonLink } from '@/components/ui/Button';
import { ListingGrid } from '@/components/ui/ListingCard';
import { PageHeader } from '@/components/ui/PageHeader';
import { routes, withQuery } from '@/lib/routes';
import { getCtx } from '@/server/session';

export const metadata = { title: 'Auctions' };
export const dynamic = 'force-dynamic';

export default async function AuctionsPage({ searchParams }: { searchParams: Promise<{ cursor?: string; status?: string }> }) {
  const sp = await searchParams;
  const ctx = await getCtx();
  const [live, upcoming, ended] = await Promise.all([
    listAuctions(ctx, { status: 'live', limit: 24, cursor: sp.status === 'live' ? sp.cursor : undefined }),
    listAuctions(ctx, { status: 'upcoming', limit: 12 }),
    listAuctions(ctx, { status: 'ended', limit: 8 }),
  ]);
  return (
    <div className="mx-auto max-w-7xl space-y-10 px-4 py-6">
      <PageHeader
        title="Auctions"
        description="Scheduled single-piece auctions. The rules are shown before you bid, server time decides, and a late bid extends the end so nobody gets sniped."
      />
      <section aria-labelledby="live-h">
        <h2 id="live-h" className="mb-3 font-serif text-2xl">Live now</h2>
        <ListingGrid items={live.items} emptyText="No auctions are live right now. Check the upcoming ones below." />
        {live.nextCursor && (
          <div className="mt-4 flex justify-center">
            <ButtonLink href={withQuery(routes.auctions, { status: 'live', cursor: live.nextCursor })} variant="secondary">More live auctions</ButtonLink>
          </div>
        )}
      </section>
      <section aria-labelledby="upcoming-h">
        <h2 id="upcoming-h" className="mb-3 font-serif text-2xl">Starting soon</h2>
        <ListingGrid items={upcoming.items} emptyText="No upcoming auctions yet." />
      </section>
      {ended.items.length > 0 && (
        <section aria-labelledby="ended-h">
          <h2 id="ended-h" className="mb-3 font-serif text-2xl text-muted">Recently ended</h2>
          <ListingGrid items={ended.items} />
        </section>
      )}
    </div>
  );
}
