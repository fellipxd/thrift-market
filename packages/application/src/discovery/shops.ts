import { approximateDistanceLabel, DELIVERY_METHOD_LABEL, REPUTATION_TIER_LABEL, stateLabel, type ReputationTier } from '@thrift/domain';
import { firstPhotoSql } from './sql';

/**
 * Public shop summary for discovery lists. Location is the shop's public area/city/state text and an approximate
 * distance label only: coordinates and raw distances are never part of this object.
 */
export interface ShopSummary {
  id: string;
  slug: string;
  name: string;
  area: string | null;
  city: string;
  state: string;
  locationLabel: string;
  distanceLabel: string | null;
  verified: boolean;
  verificationLabel: string | null;
  reputationTier: ReputationTier;
  reputationLabel: string;
  reviewCount: number;
  ratingAvg: number | null;
  activeCount: number;
  thumbnails: string[];
  coverage: CoverageSummary;
  /** Whether the shop can deliver to the buyer's chosen location (null when no location is known). */
  deliversToYou: boolean | null;
  sponsored?: boolean;
}

export interface CoverageSummary {
  scope: 'local' | 'states' | 'national';
  text: string;
  methods: string[];
}

/**
 * Columns for a ShopSummary row (aliases: s shops, dc delivery_coverage LEFT JOIN). `nowParam` keeps ended
 * auctions out of the active count and thumbnails.
 */
export function shopSummaryColumns(nowParam: string): string {
  // Open auction for a listing (at most one: auctions_listing_open_uq), checked only for auction listings.
  const liveAuction = (alias: string) =>
    `EXISTS (SELECT 1 FROM auctions ax WHERE ax.listing_id = ${alias}.id AND ax.status IN ('scheduled','live') AND ax.ends_at > ${nowParam})`;
  return `
    s.id, s.slug, s.name, s.area, s.city, s.state, s.status AS shop_status, s.verification_status, s.verification_label,
    s.reputation_tier, s.review_count, s.rating_avg,
    dc.scope AS coverage_scope, dc.states AS coverage_states, dc.excluded_states AS coverage_excluded,
    dc.offers_pickup, dc.offers_seller_arranged, dc.offers_integrated,
    CASE WHEN s.status = 'active' THEN (
      (SELECT count(*) FROM listings la WHERE la.shop_id = s.id AND la.status = 'active' AND la.sale_mode <> 'auction')
      + (SELECT count(*) FROM auctions ax JOIN listings la ON la.id = ax.listing_id
          WHERE ax.shop_id = s.id AND ax.status IN ('scheduled','live') AND ax.ends_at > ${nowParam} AND la.status = 'active' AND la.sale_mode = 'auction')
    )::int ELSE 0 END AS active_count,
    CASE WHEN s.status = 'active' THEN ARRAY(
      SELECT ph.key FROM (
        SELECT ${firstPhotoSql('lt')} AS key
          FROM listings lt
         WHERE lt.shop_id = s.id AND lt.status IN ('active','reserved') AND (lt.sale_mode <> 'auction' OR ${liveAuction('lt')})
         ORDER BY lt.published_at DESC, lt.id DESC
         LIMIT 6
      ) ph WHERE ph.key IS NOT NULL LIMIT 3
    ) ELSE ARRAY[]::text[] END AS thumbnails`;
}

export interface ShopSummaryRow {
  id: string;
  slug: string;
  name: string;
  area: string | null;
  city: string;
  state: string;
  shop_status: string;
  verification_status: string;
  verification_label: string | null;
  reputation_tier: ReputationTier;
  review_count: number;
  rating_avg: number | null;
  coverage_scope: 'local' | 'states' | 'national' | null;
  coverage_states: string[] | null;
  coverage_excluded: string[] | null;
  offers_pickup: boolean | null;
  offers_seller_arranged: boolean | null;
  offers_integrated: boolean | null;
  active_count: number;
  thumbnails: string[] | null;
  distance_m?: number | null;
  delivers_to_you?: boolean | null;
  [k: string]: unknown;
}

function listStates(states: string[], max = 3): string {
  const names = states.map(stateLabel);
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

/** Plain-language coverage line, e.g. "Delivers nationwide (except Borno)" or "Delivers within Lagos only". */
export function coverageSummary(args: {
  scope: 'local' | 'states' | 'national';
  states: string[];
  excludedStates: string[];
  offersPickup: boolean;
  offersSellerArranged: boolean;
  offersIntegrated: boolean;
  shopState: string;
}): CoverageSummary {
  const home = stateLabel(args.shopState);
  let text: string;
  if (args.scope === 'national') {
    text = args.excludedStates.length ? `Delivers nationwide (except ${listStates(args.excludedStates)})` : 'Delivers nationwide';
  } else if (args.scope === 'states') {
    const others = args.states.filter((s) => s !== args.shopState && !args.excludedStates.includes(s));
    text = others.length ? `Delivers within ${home} and to ${listStates(others)}` : `Delivers within ${home} only`;
  } else {
    text = `Delivers within ${home} only`;
  }
  const methods: string[] = [];
  if (args.offersIntegrated) methods.push(DELIVERY_METHOD_LABEL.integrated);
  if (args.offersSellerArranged) methods.push(DELIVERY_METHOD_LABEL.seller_arranged);
  if (args.offersPickup) methods.push(DELIVERY_METHOD_LABEL.pickup);
  return { scope: args.scope, text, methods };
}

export function toShopSummary(r: ShopSummaryRow, extra: { sponsored?: boolean } = {}): ShopSummary {
  const scope = r.coverage_scope ?? 'local';
  const city = r.state === 'FCT' && r.city === 'FCT' ? 'Abuja' : r.city;
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    area: r.area,
    city,
    state: r.state,
    locationLabel: [r.area, city || stateLabel(r.state)].filter(Boolean).join(', '),
    distanceLabel: r.distance_m === null || r.distance_m === undefined ? null : approximateDistanceLabel(Number(r.distance_m) / 1000),
    verified: r.verification_status === 'approved',
    verificationLabel: r.verification_status === 'approved' ? (r.verification_label ?? 'Identity verified') : null,
    reputationTier: r.reputation_tier,
    reputationLabel: REPUTATION_TIER_LABEL[r.reputation_tier] ?? REPUTATION_TIER_LABEL.new,
    reviewCount: r.review_count,
    ratingAvg: r.rating_avg === null ? null : Number(r.rating_avg),
    activeCount: r.active_count,
    thumbnails: (r.thumbnails ?? []).slice(0, 3),
    coverage: coverageSummary({
      scope,
      states: r.coverage_states ?? [],
      excludedStates: r.coverage_excluded ?? [],
      offersPickup: r.offers_pickup ?? false,
      offersSellerArranged: r.offers_seller_arranged ?? true,
      offersIntegrated: r.offers_integrated ?? false,
      shopState: r.state,
    }),
    deliversToYou: r.delivers_to_you === undefined || r.delivers_to_you === null ? null : Boolean(r.delivers_to_you),
    ...(extra.sponsored ? { sponsored: true } : {}),
  };
}

/** Reputation ordering key (higher = better), negated for ascending keyset ordering. Integer, exact. */
export const NEG_REPUTATION_KEY_SQL = `(-(
    (CASE s.reputation_tier WHEN 'trusted' THEN 3 WHEN 'established' THEN 2 WHEN 'new' THEN 1 ELSE 0 END)::bigint * 1000000000
    + coalesce(round(s.rating_avg * 100), 0)::bigint * 100000
    + least(s.review_count, 99999)::bigint))`;
