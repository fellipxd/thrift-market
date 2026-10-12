import { DomainError } from './errors';

export type AuctionStatus =
  | 'draft'
  | 'scheduled'
  | 'live'
  | 'ended_no_bids'
  | 'awaiting_payment'
  | 'paid'
  | 'failed_unpaid'
  | 'cancelled';

export interface AuctionRules {
  openingPriceMinor: number;
  incrementMinor: number;
  /** A valid bid this close to the end extends the auction (anti-sniping). */
  extensionWindowSeconds: number;
  /** New end = bid time + extensionSeconds (never earlier than the current end). */
  extensionSeconds: number;
  /** Total extension cap measured from the original end. */
  maxExtensionSeconds: number;
}

export interface AuctionState extends AuctionRules {
  status: AuctionStatus;
  startsAt: Date;
  endsAt: Date;
  originalEndsAt: Date;
  currentBidMinor: number | null;
  currentBidderId: string | null;
  sellerUserId: string;
}

export const DEFAULT_AUCTION_RULES: Omit<AuctionRules, 'openingPriceMinor' | 'incrementMinor'> = {
  extensionWindowSeconds: 120,
  extensionSeconds: 120,
  maxExtensionSeconds: 600,
};

export const WINNER_PAYMENT_HOURS_DEFAULT = 24;

export function minimumNextBid(s: Pick<AuctionState, 'currentBidMinor' | 'openingPriceMinor' | 'incrementMinor'>): number {
  return s.currentBidMinor === null ? s.openingPriceMinor : s.currentBidMinor + s.incrementMinor;
}

/** Live-ness from authoritative server time (status may lag the clock until the worker runs). */
export function isAcceptingBids(s: Pick<AuctionState, 'status' | 'startsAt' | 'endsAt'>, now: Date): boolean {
  const t = now.getTime();
  return (s.status === 'live' || s.status === 'scheduled') && t >= s.startsAt.getTime() && t < s.endsAt.getTime();
}

export interface BidDecision {
  newEndsAt: Date;
  extended: boolean;
}

/**
 * Validates a bid against the serialized auction state (call only while holding the auction row lock,
 * with `now` read after acquiring the lock). Applies the anti-sniping extension.
 */
export function evaluateBid(s: AuctionState, bid: { bidderId: string; amountMinor: number }, now: Date): BidDecision {
  if (!isAcceptingBids(s, now)) {
    if (now.getTime() < s.startsAt.getTime()) throw new DomainError('INVALID_STATE', 'This auction has not started yet.');
    throw new DomainError('EXPIRED', 'This auction has ended.');
  }
  if (bid.bidderId === s.sellerUserId) throw new DomainError('FORBIDDEN', 'Sellers cannot bid on their own auctions.');
  if (!Number.isSafeInteger(bid.amountMinor) || bid.amountMinor <= 0) {
    throw new DomainError('VALIDATION_FAILED', 'Enter a valid bid amount.');
  }
  if (s.currentBidderId === bid.bidderId) {
    throw new DomainError('CONFLICT', 'You already have the highest bid.');
  }
  const min = minimumNextBid(s);
  if (bid.amountMinor < min) {
    throw new DomainError('CONFLICT', 'Your bid is below the minimum next bid.', { minimumNextBidMinor: min });
  }
  const remainingMs = s.endsAt.getTime() - now.getTime();
  if (remainingMs <= s.extensionWindowSeconds * 1000) {
    const cap = s.originalEndsAt.getTime() + s.maxExtensionSeconds * 1000;
    const proposed = Math.min(now.getTime() + s.extensionSeconds * 1000, cap);
    if (proposed > s.endsAt.getTime()) return { newEndsAt: new Date(proposed), extended: true };
  }
  return { newEndsAt: s.endsAt, extended: false };
}

export function validateAuctionSchedule(args: {
  startsAt: Date;
  endsAt: Date;
  now: Date;
  openingPriceMinor: number;
  incrementMinor: number;
}): void {
  const { startsAt, endsAt, now, openingPriceMinor, incrementMinor } = args;
  if (startsAt.getTime() < now.getTime() - 60_000) throw new DomainError('VALIDATION_FAILED', 'Start time must be in the future.');
  const duration = endsAt.getTime() - startsAt.getTime();
  if (duration < 15 * 60_000) throw new DomainError('VALIDATION_FAILED', 'Auctions must run for at least 15 minutes.');
  if (duration > 7 * 86_400_000) throw new DomainError('VALIDATION_FAILED', 'Auctions can run for at most 7 days.');
  if (!Number.isSafeInteger(openingPriceMinor) || openingPriceMinor < 10_000) {
    throw new DomainError('VALIDATION_FAILED', 'Opening price must be at least ₦100.');
  }
  if (!Number.isSafeInteger(incrementMinor) || incrementMinor < 5_000) {
    throw new DomainError('VALIDATION_FAILED', 'Minimum increment must be at least ₦50.');
  }
  if (incrementMinor > openingPriceMinor) {
    throw new DomainError('VALIDATION_FAILED', 'Increment cannot be larger than the opening price.');
  }
}

/** Suggested increment ladder (sellers may choose a larger increment). */
export function suggestedIncrement(priceMinor: number): number {
  if (priceMinor < 500_000) return 20_000; // < ₦5,000 → ₦200
  if (priceMinor < 2_000_000) return 50_000; // < ₦20,000 → ₦500
  if (priceMinor < 10_000_000) return 100_000; // < ₦100,000 → ₦1,000
  return 500_000;
}
