import { DomainError } from './errors';

export type DeliveryMethod = 'integrated' | 'seller_arranged' | 'pickup';

export const DELIVERY_METHOD_LABEL: Record<DeliveryMethod, string> = {
  integrated: 'Platform courier',
  seller_arranged: 'Seller-arranged delivery',
  pickup: 'Pickup from seller',
};

export type TrackingConfidence = 'none' | 'seller_reported' | 'courier_verified' | 'buyer_confirmed' | 'staff_verified';

export const TRACKING_CONFIDENCE_LABEL: Record<TrackingConfidence, string> = {
  none: 'No tracking yet',
  seller_reported: 'Reported by seller',
  courier_verified: 'Verified by courier',
  buyer_confirmed: 'Confirmed by buyer',
  staff_verified: 'Verified by support',
};

export interface ShopCoverage {
  scope: 'local' | 'states' | 'national';
  states: string[];
  excludedStates: string[];
  offersPickup: boolean;
  offersSellerArranged: boolean;
  offersIntegrated: boolean;
  sameCityFeeMinor: number;
  sameStateFeeMinor: number;
  interstateFeeMinor: number;
  transitDaysMin: number;
  transitDaysMax: number;
}

export interface CourierRoute {
  originState: string;
  destinationState: string;
  feeMinor: number;
  transitDaysMin: number;
  transitDaysMax: number;
}

export interface DeliveryOption {
  method: DeliveryMethod;
  label: string;
  feeMinor: number;
  transitDaysMin: number;
  transitDaysMax: number;
  dispatchDays: number;
  /** Shown to buyers so they know who is accountable for tracking. */
  trackingNote: string;
  protectionEligible: boolean;
}

function normaliseCity(c: string): string {
  return c.trim().toLowerCase();
}

/** Does the shop declare it will deliver to this state? (Before checking actual routes.) */
export function shopCoversState(cov: ShopCoverage, shopState: string, destState: string, listingStates: string[] | null): boolean {
  if (cov.excludedStates.includes(destState)) return false;
  if (listingStates && listingStates.length > 0 && !listingStates.includes(destState)) return false;
  switch (cov.scope) {
    case 'local':
      return destState === shopState;
    case 'states':
      return destState === shopState || cov.states.includes(destState);
    case 'national':
      return true;
  }
}

/**
 * Checkout eligibility = shop coverage ∩ listing restriction ∩ actually supported route.
 * Returns the delivery options for this destination (possibly empty → not deliverable).
 */
export function deliveryOptionsFor(args: {
  coverage: ShopCoverage;
  shop: { state: string; city: string; dispatchDays: number };
  destination: { state: string; city: string };
  listingStates: string[] | null;
  courierRoute: CourierRoute | null;
  pickupAllowed?: boolean;
}): DeliveryOption[] {
  const { coverage, shop, destination, listingStates, courierRoute } = args;
  const options: DeliveryOption[] = [];
  const covered = shopCoversState(coverage, shop.state, destination.state, listingStates);
  const sameState = destination.state === shop.state;
  const sameCity = sameState && normaliseCity(destination.city) === normaliseCity(shop.city);
  if (covered && coverage.offersIntegrated && courierRoute) {
    options.push({
      method: 'integrated',
      label: 'Platform courier',
      feeMinor: courierRoute.feeMinor,
      transitDaysMin: courierRoute.transitDaysMin,
      transitDaysMax: courierRoute.transitDaysMax,
      dispatchDays: shop.dispatchDays,
      trackingNote: 'Courier milestones are recorded automatically. This is milestone tracking, not live GPS.',
      protectionEligible: true,
    });
  }
  if (covered && coverage.offersSellerArranged) {
    const fee = sameCity ? coverage.sameCityFeeMinor : sameState ? coverage.sameStateFeeMinor : coverage.interstateFeeMinor;
    options.push({
      method: 'seller_arranged',
      label: 'Seller-arranged delivery',
      feeMinor: fee,
      transitDaysMin: sameCity ? Math.min(1, coverage.transitDaysMin) : coverage.transitDaysMin,
      transitDaysMax: sameCity ? Math.min(2, coverage.transitDaysMax) : coverage.transitDaysMax,
      dispatchDays: shop.dispatchDays,
      trackingNote: 'The seller arranges delivery and reports progress. You confirm receipt before the seller is paid.',
      protectionEligible: true,
    });
  }
  if (coverage.offersPickup && sameCity && args.pickupAllowed !== false) {
    options.push({
      method: 'pickup',
      label: 'Pickup from seller',
      feeMinor: 0,
      transitDaysMin: 0,
      transitDaysMax: 0,
      dispatchDays: shop.dispatchDays,
      trackingNote: 'Meet the seller at their stated pickup point. Confirm collection in your order.',
      protectionEligible: true,
    });
  }
  return options;
}

export function pickDeliveryOption(options: DeliveryOption[], method: DeliveryMethod): DeliveryOption {
  const opt = options.find((o) => o.method === method);
  if (!opt) throw new DomainError('NOT_DELIVERABLE', 'This delivery option is not available for your address.');
  return opt;
}
