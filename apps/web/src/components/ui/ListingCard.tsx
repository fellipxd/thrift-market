import Link from 'next/link';
import type { ListingCard } from '@thrift/application';
import { CONDITION_INFO, formatNaira, stateLabel, type ConditionGrade } from '@thrift/domain';
import { routes } from '@/lib/routes';
import { Badge } from './Badge';
import { Photo } from './Photo';

export type ListingCardData = ListingCard;

/** Product card used by home, search, shop, saved and nearby. Never implies stock beyond recorded units. */
export type SponsoredPlacement = 'home_feed' | 'search_results';

export function ListingCard({ item, placement }: { item: ListingCardData; placement?: SponsoredPlacement }) {
  const price = item.saleMode === 'auction' ? item.auctionCurrentMinor ?? item.priceMinor : item.priceMinor;
  const className = 'block rounded-[var(--radius-card)] focus-visible:outline-offset-4';
  const body = (
    <>
      <div className="relative aspect-[4/5] overflow-hidden rounded-[var(--radius-card)] bg-sand">
        <Photo storageKey={item.photoKey} alt={item.title} className="h-full w-full transition-transform group-hover:scale-[1.02]" />
        <div className="absolute left-2 top-2 flex flex-wrap gap-1">
          {item.sponsored && <Badge tone="accent" className="bg-surface">Sponsored</Badge>}
          {item.saleMode === 'auction' && <Badge tone="info" className="bg-surface">Auction</Badge>}
          {item.status === 'reserved' && <Badge tone="warning" className="bg-surface">Reserved</Badge>}
          {item.status === 'sold' && <Badge tone="neutral" className="bg-surface">Sold</Badge>}
        </div>
      </div>
      <div className="mt-2 space-y-0.5 px-0.5">
        <h3 className="line-clamp-1 text-[15px] font-semibold text-ink">{item.title}</h3>
        <p className="text-base font-bold text-primary">
          {price ? formatNaira(price) : '—'}
          {item.saleMode === 'auction' && <span className="ml-1 text-xs font-medium text-muted">{item.auctionCurrentMinor ? 'current bid' : 'opening'}</span>}
          {item.saleMode === 'negotiable' && <span className="ml-1 text-xs font-medium text-muted">negotiable</span>}
        </p>
        <p className="line-clamp-1 text-xs text-muted">
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
    <div className="grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {items.map((i) => (
        <ListingCard key={i.id} item={i} placement={placement} />
      ))}
    </div>
  );
}
