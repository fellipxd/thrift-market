import type { SqlParams } from './sql';

/**
 * SQL mirror of `deliveryOptionsFor(...).length > 0` from @thrift/domain (delivery.ts), so search can filter by
 * deliverable destination without loading each listing. Requires aliases `s` (shops) and `dc`
 * (delivery_coverage, LEFT JOINed; missing rows use the same defaults as delivery/quote.ts), and `l` (listings)
 * when `listingScoped` is true (listing.delivery_states narrows the shop coverage).
 *
 * Deliverable = (covered AND (seller-arranged OR (integrated AND an active courier route shop.state → dest)))
 *               OR (pickup AND same city)
 * covered     = dest not excluded AND listing narrowing allows dest AND scope admits dest (local / states / national)
 *
 * Integration tests cross-check this predicate against the domain function over a coverage matrix.
 */
export function deliverableSql(
  p: SqlParams,
  args: { state: string; city: string | null; courierProvider: string; listingScoped: boolean },
): string {
  const dest = p.add(args.state, 'text');
  const provider = p.add(args.courierProvider, 'text');
  const listingNarrowing = args.listingScoped
    ? `AND (l.delivery_states IS NULL OR cardinality(l.delivery_states) = 0 OR ${dest} = ANY(l.delivery_states))`
    : '';
  const covered = `(
      NOT (${dest} = ANY(coalesce(dc.excluded_states, '{}'::text[])))
      ${listingNarrowing}
      AND (CASE coalesce(dc.scope, 'local')
             WHEN 'national' THEN true
             WHEN 'states' THEN (s.state = ${dest} OR ${dest} = ANY(coalesce(dc.states, '{}'::text[])))
             ELSE s.state = ${dest} END)
    )`;
  const shipped = `(
      coalesce(dc.offers_seller_arranged, true)
      OR (coalesce(dc.offers_integrated, false) AND EXISTS (
            SELECT 1 FROM courier_routes cr
             WHERE cr.provider = ${provider} AND cr.origin_state = s.state AND cr.destination_state = ${dest} AND cr.active))
    )`;
  const city = args.city?.trim();
  const pickup = city
    ? `OR (coalesce(dc.offers_pickup, false) AND s.state = ${dest} AND lower(btrim(s.city)) = lower(btrim(${p.add(city, 'text')})))`
    : '';
  return `((${covered} AND ${shipped}) ${pickup})`;
}
