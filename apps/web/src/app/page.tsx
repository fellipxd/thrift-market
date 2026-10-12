import Link from 'next/link';
import { getHomeFeed } from '@thrift/application';
import { LocationBar } from '@/components/discovery/LocationBar';
import { ShopCard } from '@/components/discovery/ShopCard';
import { ButtonLink } from '@/components/ui/Button';
import { ListingGrid } from '@/components/ui/ListingCard';
import { routes } from '@/lib/routes';
import { getLocationPreference } from '@/server/location';
import { recordSponsoredImpressions } from '@/server/promotions';
import { getCtx } from '@/server/session';

function Section({ title, href, linkText = 'See all', children }: { title: string; href?: string; linkText?: string; children: React.ReactNode }) {
  return (
    <section className="mt-10" aria-label={title}>
      <div className="mb-4 flex items-end justify-between gap-3">
        <h2 className="text-xl font-semibold text-ink">{title}</h2>
        {href && <Link href={href} className="text-sm font-semibold text-primary underline">{linkText}</Link>}
      </div>
      {children}
    </section>
  );
}

export default async function HomePage() {
  const location = await getLocationPreference();
  const feed = await getHomeFeed(await getCtx(), location);
  await recordSponsoredImpressions('home_feed', feed.newDrops.filter((i) => i.sponsored).map((i) => i.id));
  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-serif text-2xl text-primary sm:text-4xl">Good finds. Clearly described.</h1>
          <p className="mt-1 text-muted">Secondhand clothes, shoes, bags and accessories from sellers across Nigeria.</p>
        </div>
        <LocationBar location={feed.location} />
      </div>
      <nav aria-label="Quick filters" className="mt-4 flex flex-wrap gap-2">
        <Link href={routes.search({ sort: 'newest' })} className="rounded-lg bg-primary-soft px-3 py-2 text-sm font-semibold text-primary">New drops</Link>
        <Link href={routes.nearby()} className="rounded-lg bg-primary-soft px-3 py-2 text-sm font-semibold text-primary">Near me</Link>
        <Link href={routes.auctions} className="rounded-lg bg-primary-soft px-3 py-2 text-sm font-semibold text-primary">Auctions</Link>
        {feed.categories.map((c) => (
          <Link key={c.slug} href={routes.search({ category: c.slug })} className="rounded-lg bg-surface px-3 py-2 text-sm font-semibold text-ink">
            {c.name}
          </Link>
        ))}
      </nav>

      {feed.following && feed.following.length > 0 && (
        <Section title="Fresh from sellers you follow" href={routes.following}>
          <ListingGrid items={feed.following} />
        </Section>
      )}

      <Section title="New drops" href={routes.search({ sort: 'newest' })}>
        <ListingGrid items={feed.newDrops} placement="home_feed" emptyText="No pieces yet — check back soon." />
        {feed.newDrops.some((i) => i.sponsored) && <p className="mt-3 text-xs text-muted">Sponsored pieces are paid placements and are always labelled.</p>}
      </Section>

      {(feed.liveAuctions.length > 0 || feed.upcomingAuctions.length > 0) && (
        <Section title="Auctions" href={routes.auctions}>
          {feed.liveAuctions.length > 0 && <ListingGrid items={feed.liveAuctions} />}
          {feed.upcomingAuctions.length > 0 && (
            <>
              <h3 className="mb-3 mt-6 font-semibold text-muted">Starting soon</h3>
              <ListingGrid items={feed.upcomingAuctions} />
            </>
          )}
        </Section>
      )}

      {feed.nearYou && (
        <Section title={`Near ${feed.location?.name ?? 'you'}`} href={routes.nearby()} linkText="Nearby shops">
          <ListingGrid items={feed.nearYou} emptyText="No pieces from nearby shops yet. Try a wider search." />
        </Section>
      )}

      {feed.shops.length > 0 && (
        <Section title="Shops to discover" href={routes.nearby()}>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {feed.shops.map((s) => (
              <ShopCard key={s.id} shop={s} />
            ))}
          </div>
        </Section>
      )}

      <section className="mt-12 rounded-[var(--radius-card)] bg-primary p-6 text-white sm:p-8">
        <h2 className="font-serif text-2xl">Sell from your rail, not your DMs</h2>
        <p className="mt-2 max-w-xl text-white/90">One shop link, clear condition details, offers, auctions and protected checkout — keep your customers and lose the repeated questions.</p>
        <ButtonLink href={routes.sell.home} variant="secondary" className="mt-4">Open a shop</ButtonLink>
      </section>
    </div>
  );
}
