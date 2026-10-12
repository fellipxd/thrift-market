import { describe, expect, it } from 'vitest';
import { applyBps, formatNaira, parseNairaToMinor, computeOrderTotals, ZERO_FEES } from '../src';

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
});
