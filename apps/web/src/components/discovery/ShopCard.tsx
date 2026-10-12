import Link from 'next/link';
import type { ShopSummary } from '@thrift/application';
import { Badge } from '@/components/ui/Badge';
import { Photo } from '@/components/ui/Photo';
import { routes } from '@/lib/routes';

export function ShopCard({ shop }: { shop: ShopSummary }) {
  return (
    <article className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={routes.shop(shop.slug)} className="line-clamp-1 text-lg font-semibold text-primary hover:underline">{shop.name}</Link>
          <p className="text-sm text-muted">
            {shop.locationLabel}
            {shop.distanceLabel ? ` · ${shop.distanceLabel}` : ''}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          {shop.sponsored && <Badge tone="accent">Sponsored</Badge>}
          {shop.verified && <Badge tone="success">{shop.verificationLabel ?? 'Identity checked'}</Badge>}
        </div>
      </div>
      <p className="mt-2 text-sm">
        <span className="font-medium">{shop.reputationLabel}</span>
        {' · '}
        {shop.reviewCount > 0 && shop.ratingAvg !== null ? `${shop.ratingAvg.toFixed(1)} from ${shop.reviewCount} ${shop.reviewCount === 1 ? 'review' : 'reviews'}` : 'No reviews yet'}
        {' · '}
        {shop.activeCount} on sale
      </p>
      <p className="text-xs text-muted">
        {shop.coverage.text}
        {shop.deliversToYou === true ? ' · delivers to you' : shop.deliversToYou === false ? ' · doesn’t deliver to your location' : ''}
      </p>
      {shop.thumbnails.length > 0 && (
        <ul className="mt-3 grid grid-cols-3 gap-2" aria-label={`Pieces from ${shop.name}`}>
          {shop.thumbnails.slice(0, 3).map((key) => (
            <li key={key}>
              <Photo storageKey={key} alt="" className="aspect-square w-full rounded-lg" />
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
