import type { ConditionGrade } from '@thrift/domain';

/**
 * Shared projection for listing cards (home, search, shop, saved, nearby). Compose as:
 *   SELECT ${LISTING_CARD_COLUMNS} FROM ${LISTING_CARD_FROM} WHERE ... ORDER BY ... LIMIT ...
 * Only public fields: never select min_offer_minor or precise locations here.
 */
export const LISTING_CARD_COLUMNS = `
  l.id, l.title, l.price_minor, l.sale_mode, l.status, l.condition, l.size_label, l.published_at,
  s.id AS shop_id, s.slug AS shop_slug, s.name AS shop_name, s.city, s.state, s.verification_status,
  st.quantity_available,
  (SELECT m.storage_key FROM listing_media lm JOIN media_assets m ON m.id = lm.media_id
    WHERE lm.listing_id = l.id ORDER BY lm.position LIMIT 1) AS photo_key,
  a.id AS auction_id, a.status AS auction_status, a.current_bid_minor, a.opening_price_minor, a.ends_at AS auction_ends_at, a.starts_at AS auction_starts_at`;

export const LISTING_CARD_FROM = `
  listings l
  JOIN shops s ON s.id = l.shop_id
  LEFT JOIN inventory_stock st ON st.listing_id = l.id
  LEFT JOIN LATERAL (SELECT * FROM auctions ax WHERE ax.listing_id = l.id ORDER BY ax.created_at DESC LIMIT 1) a ON true`;

/** Public visibility: published listings of active shops. */
export const LISTING_PUBLIC_WHERE = `s.status = 'active' AND l.status IN ('active','reserved')`;

export interface ListingCardRow {
  id: string;
  title: string;
  price_minor: number | null;
  sale_mode: 'fixed' | 'negotiable' | 'auction';
  status: string;
  condition: ConditionGrade | null;
  size_label: string | null;
  published_at: Date | null;
  shop_id: string;
  shop_slug: string;
  shop_name: string;
  city: string;
  state: string;
  verification_status: string;
  quantity_available: number | null;
  photo_key: string | null;
  auction_id: string | null;
  auction_status: string | null;
  current_bid_minor: number | null;
  opening_price_minor: number | null;
  auction_ends_at: Date | null;
  auction_starts_at: Date | null;
  [k: string]: unknown;
}

export interface ListingCard {
  id: string;
  title: string;
  priceMinor: number | null;
  saleMode: 'fixed' | 'negotiable' | 'auction';
  status: string;
  condition: ConditionGrade | null;
  sizeLabel: string | null;
  city: string;
  state: string;
  photoKey: string | null;
  shopName: string;
  shopSlug: string;
  shopVerified: boolean;
  quantityAvailable: number | null;
  auctionId: string | null;
  auctionCurrentMinor: number | null;
  auctionEndsAt: string | null;
  auctionStatus: string | null;
  sponsored?: boolean;
}

export function toListingCard(r: ListingCardRow, extra: { sponsored?: boolean } = {}): ListingCard {
  return {
    id: r.id,
    title: r.title,
    priceMinor: r.sale_mode === 'auction' ? r.opening_price_minor : r.price_minor,
    saleMode: r.sale_mode,
    status: r.status,
    condition: r.condition,
    sizeLabel: r.size_label,
    city: r.city,
    state: r.state,
    photoKey: r.photo_key,
    shopName: r.shop_name,
    shopSlug: r.shop_slug,
    shopVerified: r.verification_status === 'approved',
    quantityAvailable: r.quantity_available,
    auctionId: r.auction_id,
    auctionCurrentMinor: r.current_bid_minor,
    auctionEndsAt: r.auction_ends_at ? new Date(r.auction_ends_at).toISOString() : null,
    auctionStatus: r.auction_status,
    ...(extra.sponsored ? { sponsored: true } : {}),
  };
}
