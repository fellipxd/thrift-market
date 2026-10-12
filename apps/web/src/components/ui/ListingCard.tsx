import Link from 'next/link';
import type { ListingCard } from '@thrift/application';
import { CONDITION_INFO, formatNaira, stateLabel, type ConditionGrade } from '@thrift/domain';
import { routes } from '@/lib/routes';
import { Photo } from './Photo';

export type ListingCardData = ListingCard;

/** Product card used by home, search, shop, saved and nearby. Never implies stock beyond recorded units. */
export type SponsoredPlacement = 'home_feed' | 'search_results';

export function ListingCard({ item, placement }: { item: ListingCardData; placement?: SponsoredPlacement }) {
  const price = item.saleMode === 'auction' ? item.auctionCurrentMinor ?? item.priceMinor : item.priceMinor;
  const className = 'block focus-visible:outline-offset-4';
  const mode = item.saleMode === 'auction' ? 'Auction' : item.saleMode === 'negotiable' ? 'Negotiable' : 'Fixed price';
  const body = (
    <>
      <div className="relative aspect-[4/5] overflow-hidden bg-sand">
        <Photo storageKey={item.photoKey} alt={item.title} className="h-full w-full transition-transform duration-500 group-hover:scale-[1.015]" />
        {(item.status === 'reserved' || item.status === 'sold') && (
          <div className="absolute left-0 top-0">
            <span className="label-caps inline-block bg-ink px-2 py-1 text-canvas">{item.status === 'sold' ? 'Sold' : 'Reserved'}</span>
          </div>
        )}
      </div>
      <div className="mt-3 space-y-1">
        <p className="label-caps flex flex-wrap gap-x-2 text-muted">
          <span>{mode}</span>
          {item.sponsored && <span className="text-accent">Sponsored</span>}
        </p>
        {/* Full titles wrap rather than being cut, so identifying words stay visible. */}
        <h3 className="font-serif text-xl leading-snug text-ink">{item.title}</h3>
        <p className="text-base font-semibold tabular-nums text-ink">
          {price ? formatNaira(price) : '—'}
          {item.saleMode === 'auction' && <span className="ml-1.5 text-sm font-normal text-muted">{item.auctionCurrentMinor ? 'current bid' : 'opening bid'}</span>}
        </p>
        <p className="text-sm text-muted">
          {[item.sizeLabel, item.condition ? CONDITION_INFO[item.condition].label : null, item.state === 'FCT' ? 'Abuja' : item.city || stateLabel(item.state)]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>
    </>
  );
  return (
    <article className="group relative">
      {item.sponsored && placement ? (
        // Sponsored entries go through the click counter with a plain link (no prefetch, so prefetching never counts).
        <a href={routes.promoted(placement, item.id)} rel="sponsored nofollow" className={className}>
          {body}
        </a>
      ) : (
        <Link href={item.saleMode === 'auction' && item.auctionId ? routes.auction(item.auctionId) : routes.item(item.id)} className={className}>
          {body}
        </Link>
      )}
    </article>
  );
}

export function ListingGrid({ items, emptyText, placement }: { items: ListingCardData[]; emptyText?: string; placement?: SponsoredPlacement }) {
  if (items.length === 0) return <p className="py-8 text-center text-muted">{emptyText ?? 'Nothing here yet.'}</p>;
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-10 min-[340px]:grid-cols-2 md:grid-cols-3 md:gap-x-6 xl:grid-cols-4">
      {items.map((i) => (
        <ListingCard key={i.id} item={i} placement={placement} />
      ))}
    </div>
  );
}
