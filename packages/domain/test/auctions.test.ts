import { describe, expect, it } from 'vitest';
import { evaluateBid, minimumNextBid, type AuctionState } from '../src';

const base = (over: Partial<AuctionState> = {}): AuctionState => ({
  status: 'live',
  startsAt: new Date('2026-10-12T10:00:00Z'),
  endsAt: new Date('2026-10-12T18:00:00Z'),
  originalEndsAt: new Date('2026-10-12T18:00:00Z'),
  openingPriceMinor: 1_000_000,
  incrementMinor: 50_000,
  extensionWindowSeconds: 120,
  extensionSeconds: 120,
  maxExtensionSeconds: 600,
  currentBidMinor: null,
  currentBidderId: null,
  sellerUserId: 'seller',
  ...over,
});

describe('auction bidding rules', () => {
  it('first bid must meet the opening price, later bids the increment', () => {
    expect(minimumNextBid(base())).toBe(1_000_000);
    expect(minimumNextBid(base({ currentBidMinor: 1_400_000 }))).toBe(1_450_000);
    expect(() => evaluateBid(base(), { bidderId: 'b', amountMinor: 999_999 }, new Date('2026-10-12T12:00:00Z'))).toThrow(/minimum/);
  });
  it('rejects seller bids, bids after end and bids before start', () => {
    expect(() => evaluateBid(base(), { bidderId: 'seller', amountMinor: 1_000_000 }, new Date('2026-10-12T12:00:00Z'))).toThrow(/Sellers/);
    expect(() => evaluateBid(base(), { bidderId: 'b', amountMinor: 1_000_000 }, new Date('2026-10-12T18:00:00Z'))).toThrow(/ended/);
    expect(() => evaluateBid(base(), { bidderId: 'b', amountMinor: 1_000_000 }, new Date('2026-10-12T09:00:00Z'))).toThrow(/not started/);
  });
  it('extends the end for bids in the final two minutes, capped at ten minutes total', () => {
    const now = new Date('2026-10-12T17:59:00Z');
    const d = evaluateBid(base(), { bidderId: 'b', amountMinor: 1_000_000 }, now);
    expect(d.extended).toBe(true);
    expect(d.newEndsAt.toISOString()).toBe('2026-10-12T18:01:00.000Z');
    const nearCap = base({ endsAt: new Date('2026-10-12T18:09:30Z') });
    const d2 = evaluateBid(nearCap, { bidderId: 'b', amountMinor: 1_000_000 }, new Date('2026-10-12T18:09:00Z'));
    expect(d2.newEndsAt.toISOString()).toBe('2026-10-12T18:10:00.000Z');
    const atCap = base({ endsAt: new Date('2026-10-12T18:10:00Z') });
    const d3 = evaluateBid(atCap, { bidderId: 'b', amountMinor: 1_000_000 }, new Date('2026-10-12T18:09:30Z'));
    expect(d3.extended).toBe(false);
  });
  it('no extension outside the window', () => {
    const d = evaluateBid(base(), { bidderId: 'b', amountMinor: 1_000_000 }, new Date('2026-10-12T17:00:00Z'));
    expect(d.extended).toBe(false);
  });
});
