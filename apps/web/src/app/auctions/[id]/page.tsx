import Link from 'next/link';
import { notFound } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { getAuctionView, getListingDetail, type AuctionView, type ListingDetail } from '@thrift/application';
import { isDomainError } from '@thrift/domain';
import { AuctionLive } from '@/components/auctions/AuctionLive';
import { ItemGallery } from '@/components/catalogue/ItemGallery';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { routes } from '@/lib/routes';
import { getCtx } from '@/server/session';
import { acceptSecondChanceAction, declineSecondChanceAction, placeBidAction } from '../actions';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const v = await getAuctionView(await getCtx(), id);
    return { title: `Auction: ${v.listing.title}` };
  } catch {
    return { title: 'Auction' };
  }
}

export default async function AuctionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getCtx();
  let view: AuctionView;
  try {
    view = await getAuctionView(ctx, id);
  } catch (err) {
    if (isDomainError(err) && err.code === 'NOT_FOUND') notFound();
    throw err;
  }
  // Full item details (description, measurements) when the piece is publicly visible; the auction stays viewable either way.
  let item: ListingDetail | null = null;
  try {
    item = await getListingDetail(ctx, view.listingId);
  } catch (err) {
    if (!isDomainError(err)) throw err;
  }
  return (
    <div className="mx-auto max-w-[1280px] px-4 py-8 md:px-8 xl:px-12">
      <nav aria-label="Breadcrumb" className="mb-3 text-sm text-muted">
        <Link href={routes.auctions} className="underline">Auctions</Link> / <span>{view.listing.title}</span>
      </nav>
      <div className="grid gap-8 lg:grid-cols-[1.1fr_1fr]">
        <div className="space-y-6">
          {item ? (
            <ItemGallery photos={item.photos} title={item.title} />
          ) : (
            view.listing.photos[0] && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={view.listing.photos[0].url} alt={view.listing.photos[0].alt} className="w-full rounded-[var(--radius-card)] bg-sand object-cover" />
            )
          )}
          <Card className="space-y-3 p-4">
            <h2 className="font-serif text-xl">Condition and details</h2>
            <p className="text-sm">
              {[view.listing.conditionLabel, view.listing.sizeLabel && `Size ${view.listing.sizeLabel}`].filter(Boolean).join(' · ')}
            </p>
            {item?.description && <p className="whitespace-pre-line text-sm text-muted">{item.description}</p>}
            {view.listing.flaws.length > 0 ? (
              <div>
                <p className="text-sm font-semibold">Disclosed flaws</p>
                <ul className="list-disc pl-5 text-sm text-muted">
                  {view.listing.flaws.map((f, i) => (
                    <li key={i}>
                      {f.description}
                      {f.location ? ` (${f.location})` : ''} — {f.severity}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-sm text-muted">The seller declares no known flaws.</p>
            )}
            {item && item.measurements.length > 0 && (
              <dl className="grid grid-cols-2 gap-1 text-sm">
                {item.measurements.map((m) => (
                  <div key={m.key} className="flex justify-between gap-2">
                    <dt className="text-muted">{m.label}</dt>
                    <dd>{m.valueCm} cm</dd>
                  </div>
                ))}
              </dl>
            )}
          </Card>
        </div>
        <div className="space-y-5">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-accent">Scheduled auction</p>
            <h1 className="display text-[2.25rem] text-ink sm:text-5xl">{view.listing.title}</h1>
            <p className="mt-1 text-sm text-muted">
              from <Link href={routes.shop(view.listing.shop.slug)} className="underline">{view.listing.shop.name}</Link> · {view.listing.shop.city}, {view.listing.shop.state}{' '}
              {view.listing.shop.verified && <Badge tone="success">Identity checked</Badge>}
            </p>
          </div>
          <AuctionLive
            initial={view}
            clientKey={randomUUID().replace(/-/g, '')}
            bidAction={placeBidAction}
            acceptSecondChance={acceptSecondChanceAction}
            declineSecondChance={declineSecondChanceAction}
          />
          <Card className="p-4">
            <h2 className="mb-2 font-serif text-xl">How this auction works</h2>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
              {view.rules.lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
            {view.policy && (
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer font-semibold text-primary">
                  {view.policy.title} (version {view.policy.version})
                </summary>
                <p className="mt-2 whitespace-pre-line text-muted">{view.policy.body}</p>
              </details>
            )}
          </Card>
          <p className="text-xs text-muted">
            Something wrong with this listing? <Link href={routes.report('listing', view.listingId)} className="underline">Report it</Link>.
          </p>
        </div>
      </div>
    </div>
  );
}
