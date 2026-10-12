import { describe, expect, it } from 'vitest';
import { applyBps, apportionMinor, apportionOrderTotals, formatNaira, parseNairaToMinor, computeOrderTotals, ZERO_FEES } from '../src';

describe('money', () => {
  it('parses naira input into kobo without floating point', () => {
    expect(parseNairaToMinor('8,500')).toBe(850_000);
    expect(parseNairaToMinor('₦8,500.50')).toBe(850_050);
    expect(parseNairaToMinor('0.1')).toBe(10);
    expect(() => parseNairaToMinor('8.505')).toThrow();
    expect(() => parseNairaToMinor('-5')).toThrow();
  });
  it('formats naira', () => {
    expect(formatNaira(850_000)).toBe('₦8,500');
    expect(formatNaira(850_050)).toBe('₦8,500.5');
  });
  it('applies basis points with half-up rounding', () => {
    expect(applyBps(10_001, 500)).toBe(500);
    expect(applyBps(10_010, 500)).toBe(501);
    expect(applyBps(0, 500)).toBe(0);
  });
  it('itemises totals with zero default fees', () => {
    const t = computeOrderTotals({ unitPriceMinor: 850_000, quantity: 1, shippingMinor: 200_000, fees: ZERO_FEES, shippingPaidToSeller: true });
    expect(t).toEqual({ itemsTotalMinor: 850_000, shippingMinor: 200_000, buyerFeeMinor: 0, totalMinor: 1_050_000, commissionMinor: 0, sellerProceedsMinor: 1_050_000 });
  });
  it('totals a same-seller order with one delivery fee and fees on the items total', () => {
    const fees = { commissionBps: 1_000, buyerFeeBps: 150, buyerFeeFlatMinor: 10_000 };
    const t = computeOrderTotals({ lines: [{ unitPriceMinor: 850_000, quantity: 1 }, { unitPriceMinor: 300_000, quantity: 2 }], shippingMinor: 200_000, fees, shippingPaidToSeller: false });
    expect(t.itemsTotalMinor).toBe(1_450_000);
    expect(t.buyerFeeMinor).toBe(21_750 + 10_000);
    expect(t.commissionMinor).toBe(145_000);
    expect(t.totalMinor).toBe(1_450_000 + 200_000 + 31_750);
    expect(t.sellerProceedsMinor).toBe(1_450_000 - 145_000);
  });
  it('apportions with integer largest remainder, exactly and deterministically', () => {
    expect(apportionMinor(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(apportionMinor(200_000, [850_000, 600_000])).toEqual([117_241, 82_759]);
    expect(apportionMinor(5, [0, 0])).toEqual([3, 2]);
    expect(apportionMinor(0, [3, 7])).toEqual([0, 0]);
    expect(apportionMinor(9_007_199_254_740, [9_007_199_254_740, 1])).toEqual([9_007_199_254_739, 1]);
    expect(() => apportionMinor(10, [])).toThrow();
    expect(() => apportionMinor(10, [-1, 2])).toThrow();
    const shares = apportionOrderTotals({ shippingMinor: 200_001, buyerFeeMinor: 31_750, commissionMinor: 145_000 }, [
      { unitPriceMinor: 850_000, quantity: 1 },
      { unitPriceMinor: 300_000, quantity: 2 },
    ]);
    expect(shares.reduce((a, s) => a + s.shippingShareMinor, 0)).toBe(200_001);
    expect(shares.reduce((a, s) => a + s.buyerFeeShareMinor, 0)).toBe(31_750);
    expect(shares.reduce((a, s) => a + s.commissionShareMinor, 0)).toBe(145_000);
  });
});
