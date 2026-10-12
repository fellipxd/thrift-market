import { deliveryOptionsFor, DomainError, type DeliveryOption, type ShopCoverage } from '@thrift/domain';
import { maybeOne, type Queryable } from '@thrift/database';

export interface DeliveryContext {
  listingId: string;
  shopId: string;
  shopState: string;
  shopCity: string;
  dispatchDays: number;
  coverage: ShopCoverage;
  listingStates: string[] | null;
}

interface CoverageRow {
  shop_id: string;
  shop_state: string;
  shop_city: string;
  dispatch_days: number;
  delivery_states: string[] | null;
  scope: ShopCoverage['scope'] | null;
  states: string[] | null;
  excluded_states: string[] | null;
  offers_pickup: boolean | null;
  offers_seller_arranged: boolean | null;
  offers_integrated: boolean | null;
  same_city_fee_minor: number | null;
  same_state_fee_minor: number | null;
  interstate_fee_minor: number | null;
  transit_days_min: number | null;
  transit_days_max: number | null;
  [k: string]: unknown;
}

export async function loadDeliveryContext(db: Queryable, listingId: string): Promise<DeliveryContext> {
  const r = await maybeOne<CoverageRow>(
    db,
    `SELECT s.id AS shop_id, s.state AS shop_state, s.city AS shop_city, s.dispatch_days, l.delivery_states,
            c.scope, c.states, c.excluded_states, c.offers_pickup, c.offers_seller_arranged, c.offers_integrated,
            c.same_city_fee_minor, c.same_state_fee_minor, c.interstate_fee_minor, c.transit_days_min, c.transit_days_max
       FROM listings l JOIN shops s ON s.id = l.shop_id LEFT JOIN delivery_coverage c ON c.shop_id = s.id
      WHERE l.id = $1`,
    [listingId],
  );
  if (!r) throw new DomainError('NOT_FOUND', 'This item is not available.');
  const coverage: ShopCoverage = {
    scope: r.scope ?? 'local',
    states: r.states ?? [],
    excludedStates: r.excluded_states ?? [],
    offersPickup: r.offers_pickup ?? false,
    offersSellerArranged: r.offers_seller_arranged ?? true,
    offersIntegrated: r.offers_integrated ?? false,
    sameCityFeeMinor: r.same_city_fee_minor ?? 150_000,
    sameStateFeeMinor: r.same_state_fee_minor ?? 250_000,
    interstateFeeMinor: r.interstate_fee_minor ?? 450_000,
    transitDaysMin: r.transit_days_min ?? 1,
    transitDaysMax: r.transit_days_max ?? 5,
  };
  return {
    listingId,
    shopId: r.shop_id,
    shopState: r.shop_state,
    shopCity: r.shop_city,
    dispatchDays: r.dispatch_days,
    coverage,
    listingStates: r.delivery_states,
  };
}

/**
 * Delivery options for one listing to one destination = shop coverage ∩ listing restriction ∩ supported courier
 * route (courier_routes, populated from the courier adapter/contract). Empty array → not deliverable.
 * Used by the item page (estimate), checkout (binding quote, re-checked before payment) and auction pages.
 */
export async function quoteDeliveryOptions(
  db: Queryable,
  args: { listingId: string; destination: { state: string; city: string }; courierProvider?: string },
): Promise<DeliveryOption[]> {
  const dc = await loadDeliveryContext(db, args.listingId);
  const route = await maybeOne<{ base_fee_minor: number; transit_days_min: number; transit_days_max: number }>(
    db,
    `SELECT base_fee_minor, transit_days_min, transit_days_max FROM courier_routes
      WHERE provider = $1 AND origin_state = $2 AND destination_state = $3 AND active`,
    [args.courierProvider ?? 'sandbox_courier', dc.shopState, args.destination.state],
  );
  return deliveryOptionsFor({
    coverage: dc.coverage,
    shop: { state: dc.shopState, city: dc.shopCity, dispatchDays: dc.dispatchDays },
    destination: args.destination,
    listingStates: dc.listingStates,
    courierRoute: route
      ? {
          originState: dc.shopState,
          destinationState: args.destination.state,
          feeMinor: route.base_fee_minor,
          transitDaysMin: route.transit_days_min,
          transitDaysMax: route.transit_days_max,
        }
      : null,
  });
}
