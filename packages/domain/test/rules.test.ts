import { describe, expect, it } from 'vitest';
import {
  applyStockMovement,
  assertOfferAction,
  canTransition,
  combineDeliveryOptions,
  computeReputation,
  deliveryOptionsFor,
  evaluateOfferAmount,
  ORDER_STATUS,
  PAYOUT_STATUS,
  validateForPublish,
  type AttributeSchema,
  type DeliveryOption,
  type ShopCoverage,
} from '../src';

const schema: AttributeSchema = { sizeRequired: true, allowedSizeSystems: ['uk'], measurements: [{ key: 'chest', label: 'Chest', required: true }], recommendedPhotoRoles: [], attributes: [] };

describe('listing publish checklist', () => {
  const ok = {
    title: 'Linen shirt', description: '', saleMode: 'fixed' as const, priceMinor: 850_000, minOfferMinor: null, condition: 'good' as const,
    flawsDeclaration: 'described' as const, flaws: [{ description: 'Small mark on cuff', mediaId: 'm1' }], sizeSystem: 'uk' as const, sizeLabel: '12',
    measurements: { chest: 104 }, attributes: {}, photoCount: 4, quantityMode: 'unique' as const, quantity: 1,
  };
  it('accepts a complete listing', () => expect(validateForPublish(ok, schema)).toEqual([]));
  it('requires photo evidence for each flaw and an explicit declaration', () => {
    expect(validateForPublish({ ...ok, flaws: [{ description: 'Stain', mediaId: null }] }, schema).map((i) => i.field)).toContain('flaws.0');
    expect(validateForPublish({ ...ok, flawsDeclaration: null }, schema).map((i) => i.field)).toContain('flaws');
    expect(validateForPublish({ ...ok, condition: 'worn', flawsDeclaration: 'none_known', flaws: [] }, schema).map((i) => i.field)).toContain('flaws');
  });
  it('requires measurements and unique quantity', () => {
    expect(validateForPublish({ ...ok, measurements: {} }, schema).map((i) => i.field)).toContain('measurements.chest');
    expect(validateForPublish({ ...ok, quantity: 2 }, schema).map((i) => i.field)).toContain('quantity');
  });
});

describe('stock', () => {
  it('never goes negative', () => {
    const s = { quantityTotal: 1, quantityAvailable: 0, quantityReserved: 1, quantitySold: 0, quantityWithdrawn: 0 };
    expect(() => applyStockMovement(s, { kind: 'reserve', quantity: 1 })).toThrow(/no longer available/);
  });
});

describe('offers', () => {
  it('auto-declines below the private minimum without revealing it', () => {
    expect(evaluateOfferAmount({ amountMinor: 500_000, askingMinor: 850_000, minOfferMinor: 700_000, fromParty: 'buyer' })).toBe('auto_decline');
    expect(evaluateOfferAmount({ amountMinor: 750_000, askingMinor: 850_000, minOfferMinor: 700_000, fromParty: 'buyer' })).toBe('ok');
    expect(() => evaluateOfferAmount({ amountMinor: 900_000, askingMinor: 850_000, minOfferMinor: null, fromParty: 'buyer' })).toThrow();
  });
  it('only the counterparty can accept; expired offers are closed', () => {
    const offer = { fromParty: 'buyer' as const, amountMinor: 1, status: 'pending' as const, expiresAt: new Date('2026-10-13T00:00:00Z') };
    expect(() => assertOfferAction(offer, 'buyer', 'accept', new Date('2026-10-12T00:00:00Z'))).toThrow();
    expect(() => assertOfferAction(offer, 'seller', 'accept', new Date('2026-10-12T00:00:00Z'))).not.toThrow();
    expect(() => assertOfferAction(offer, 'seller', 'accept', new Date('2026-10-13T00:00:00Z'))).toThrow(/expired/);
  });
});

describe('state machines', () => {
  it('payout cannot jump from held to paid', () => {
    expect(canTransition(PAYOUT_STATUS, 'held', 'paid')).toBe(false);
    expect(canTransition(ORDER_STATUS, 'cancelled', 'confirmed')).toBe(false);
  });
});

describe('delivery eligibility', () => {
  const cov: ShopCoverage = {
    scope: 'states', states: ['Lagos'], excludedStates: [], offersPickup: true, offersSellerArranged: true, offersIntegrated: true,
    sameCityFeeMinor: 150_000, sameStateFeeMinor: 250_000, interstateFeeMinor: 450_000, transitDaysMin: 1, transitDaysMax: 4,
  };
  const shop = { state: 'FCT', city: 'Abuja', dispatchDays: 2 };
  it('intersects coverage with courier routes', () => {
    const route = { originState: 'FCT', destinationState: 'Lagos', feeMinor: 420_000, transitDaysMin: 3, transitDaysMax: 6 };
    expect(deliveryOptionsFor({ coverage: cov, shop, destination: { state: 'Lagos', city: 'Ikeja' }, listingStates: null, courierRoute: route }).map((o) => o.method)).toEqual(['integrated', 'seller_arranged']);
    expect(deliveryOptionsFor({ coverage: cov, shop, destination: { state: 'Kano', city: 'Kano' }, listingStates: null, courierRoute: route })).toEqual([]);
    expect(deliveryOptionsFor({ coverage: cov, shop, destination: { state: 'FCT', city: 'abuja ' }, listingStates: null, courierRoute: null }).map((o) => o.method)).toEqual(['seller_arranged', 'pickup']);
  });
});

describe('reputation', () => {
  it('one five-star review does not outrank a proven shop', () => {
    const newbie = computeReputation({ completedOrders: 1, reviewCount: 1, ratingSum: 5, onTimeDispatches: 1, dispatchesMeasured: 1, sellerCancellations: 0, upheldDisputes: 0 });
    const proven = computeReputation({ completedOrders: 60, reviewCount: 50, ratingSum: 235, onTimeDispatches: 57, dispatchesMeasured: 60, sellerCancellations: 1, upheldDisputes: 0 });
    expect(proven.score!).toBeGreaterThan(newbie.score!);
    expect(proven.tier).toBe('trusted');
    expect(newbie.tier).toBe('new');
  });
});

describe('combined same-shop shipment', () => {
  const opt = (method: DeliveryOption['method'], feeMinor: number, transitDaysMax = 3, protectionEligible = true): DeliveryOption => ({
    method, label: method, feeMinor, transitDaysMin: 1, transitDaysMax, dispatchDays: 2, trackingNote: '', protectionEligible,
  });
  it('keeps only methods every piece supports, at one (highest) fee and the longest transit', () => {
    const combined = combineDeliveryOptions([
      [opt('seller_arranged', 250_000), opt('pickup', 0), opt('integrated', 300_000, 4)],
      [opt('seller_arranged', 250_000), opt('integrated', 320_000, 5, false)],
    ]);
    expect(combined.map((o) => o.method)).toEqual(['seller_arranged', 'integrated']);
    expect(combined[1]).toMatchObject({ feeMinor: 320_000, transitDaysMax: 5, protectionEligible: false });
    expect(combineDeliveryOptions([[opt('pickup', 0)], []])).toEqual([]);
    expect(combineDeliveryOptions([])).toEqual([]);
  });
});
