import Link from 'next/link';
import { getHomeFeed } from '@thrift/application';
import { formatNaira } from '@thrift/domain';
import { LocationBar } from '@/components/discovery/LocationBar';
import { ShopCard } from '@/components/discovery/ShopCard';
import { ButtonLink } from '@/components/ui/Button';
import { ListingGrid } from '@/components/ui/ListingCard';
import { Photo } from '@/components/ui/Photo';
import { routes } from '@/lib/routes';
import { getLocationPreference } from '@/server/location';
import { recordSponsoredImpressions } from '@/server/promotions';
import { getCtx } from '@/server/session';

function Section({ title, href, linkText = 'See all', children }: { title: string; href?: string; linkText?: string; children: React.ReactNode }) {
  return (
    <section className="mt-16 border-t border-ink pt-5 md:mt-24" aria-label={title}>
      <div className="mb-8 flex items-baseline justify-between gap-3">
        <h2 className="display text-[2rem] text-ink md:text-5xl">{title}</h2>
        {href && (
          <Link href={href} className="label-caps shrink-0 text-ink underline underline-offset-[6px]">
            {linkText}
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

/**
 * Editorial cover: one focal image (an actual listed piece, never stock or generated imagery), a serif masthead
 * headline, and the catalogue close below. Search sits in the header and the delivery destination comes first.
 */
export default async function HomePage() {
  const location = await getLocationPreference();
  const feed = await getHomeFeed(await getCtx(), location);
  await recordSponsoredImpressions('home_feed', feed.newDrops.filter((i) => i.sponsored).map((i) => i.id));
  const featured = feed.newDrops.find((i) => !i.sponsored && i.photoKey && i.saleMode !== 'auction') ?? null;
  const drops = featured ? feed.newDrops.filter((i) => i.id !== featured.id) : feed.newDrops;
  return (
    <div className="mx-auto max-w-[1280px] px-4 md:px-8 xl:px-12">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-3">
        <LocationBar location={feed.location} />
        <nav aria-label="Quick filters" className="flex flex-wrap gap-x-5 gap-y-1">
          <Link href={routes.search({ sort: 'newest' })} className="label-caps inline-flex min-h-11 items-center text-ink hover:underline">New drops</Link>
          <Link href={routes.nearby()} className="label-caps inline-flex min-h-11 items-center text-ink hover:underline">Near me</Link>
          <Link href={routes.auctions} className="label-caps inline-flex min-h-11 items-center text-ink hover:underline">Auctions</Link>
          {feed.categories.map((c) => (
            <Link key={c.slug} href={routes.search({ category: c.slug })} className="label-caps inline-flex min-h-11 items-center text-muted hover:text-ink hover:underline">
              {c.name}
            </Link>
          ))}
        </nav>
      </div>

      <section aria-label="Cover" className="grid gap-8 pt-8 md:grid-cols-12 md:gap-6 md:pt-16">
        <div className="md:col-span-6 md:self-center">
          <p className="label-caps text-accent">Secondhand fashion across Nigeria</p>
          <h1 className="display mt-4 text-[2.75rem] text-ink sm:text-6xl lg:text-[5.75rem]">
            Fashion,
            <br />
            found again.
          </h1>
          <p className="mt-6 max-w-md text-lg text-muted">
            Good pieces. New stories. Clothes, shoes, bags and accessories from sellers you can follow — every flaw described and photographed.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <ButtonLink href={routes.search({ sort: 'newest' })} size="lg">Browse new drops</ButtonLink>
            <ButtonLink href={routes.sell.home} variant="secondary" size="lg">Open a shop</ButtonLink>
          </div>
        </div>
        {featured && (
          <figure className="md:col-span-5 md:col-start-8">
            <Link href={routes.item(featured.id)} className="group block">
              <div className="aspect-[4/3] overflow-hidden bg-sand md:aspect-[4/5]">
                <Photo storageKey={featured.photoKey} alt={featured.title} className="h-full w-full transition-transform duration-700 group-hover:scale-[1.015]" />
              </div>
              <figcaption className="mt-3 flex items-baseline justify-between gap-3 border-b border-line pb-3">
                <span>
                  <span className="label-caps block text-muted">Just in</span>
                  <span className="font-serif text-xl text-ink group-hover:underline">{featured.title}</span>
                </span>
                <span className="shrink-0 font-semibold tabular-nums text-ink">{featured.priceMinor ? formatNaira(featured.priceMinor) : ''}</span>
              </figcaption>
            </Link>
          </figure>
        )}
      </section>

      {feed.following && feed.following.length > 0 && (
        <Section title="From shops you follow" href={routes.following}>
          <ListingGrid items={feed.following} />
        </Section>
      )}

      <Section title="New drops" href={routes.search({ sort: 'newest' })}>
        <ListingGrid items={drops} placement="home_feed" emptyText="No pieces yet — check back soon." />
        {feed.newDrops.some((i) => i.sponsored) && <p className="mt-6 text-sm text-muted">Sponsored pieces are paid placements and are always labelled.</p>}
      </Section>

      {(feed.liveAuctions.length > 0 || feed.upcomingAuctions.length > 0) && (
        <Section title="Auctions" href={routes.auctions}>
          {feed.liveAuctions.length > 0 && <ListingGrid items={feed.liveAuctions} />}
          {feed.upcomingAuctions.length > 0 && (
            <>
              <h3 className="label-caps mb-6 mt-10 text-muted">Starting soon</h3>
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
          <div className="grid gap-x-6 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
            {feed.shops.map((s) => (
              <ShopCard key={s.id} shop={s} />
            ))}
          </div>
        </Section>
      )}

      <section className="mt-20 grid gap-6 border-y border-ink py-10 md:mt-28 md:grid-cols-12 md:py-14">
        <h2 className="display text-4xl text-ink md:col-span-6 md:text-6xl">Sell from your rail, not your DMs.</h2>
        <div className="md:col-span-5 md:col-start-8 md:self-end">
          <p className="text-lg text-muted">
            One shop link, honest condition details, offers and auctions, and a checkout that keeps a clear record — so your customers stop asking the same questions.
          </p>
          <ButtonLink href={routes.sell.home} className="mt-6">Open a shop</ButtonLink>
        </div>
      </section>
    </div>
  );
}
