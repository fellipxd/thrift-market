import { LISTING_CARD_COLUMNS, toListingCard, type ListingCard, type ListingCardRow } from '../catalogue/cards';

/**
 * Discovery card = the shared listing card plus the auction start time (for "starts in" labels on upcoming
 * auctions). Assignable to ListingCard, so ListingGrid/ListingCard render it unchanged.
 */
export interface DiscoveryCard extends ListingCard {
  auctionStartsAt: string | null;
}

/** Card columns for discovery queries (shared projection; never min_offer_minor or locations). */
export const DISCOVERY_CARD_COLUMNS = LISTING_CARD_COLUMNS;

export function toDiscoveryCard(r: ListingCardRow, extra: { sponsored?: boolean } = {}): DiscoveryCard {
  return {
    ...toListingCard(r, extra),
    auctionStartsAt: r.auction_starts_at ? new Date(r.auction_starts_at).toISOString() : null,
  };
}
