import { DomainError } from './errors';

export type OfferParty = 'buyer' | 'seller';
export type OfferStatus = 'pending' | 'countered' | 'accepted' | 'rejected' | 'withdrawn' | 'expired' | 'auto_declined';
export type OfferThreadStatus = 'open' | 'accepted' | 'rejected' | 'withdrawn' | 'expired' | 'closed_unavailable' | 'completed';

export const OFFER_EXPIRY_HOURS_DEFAULT = 24;

export interface PendingOffer {
  fromParty: OfferParty;
  amountMinor: number;
  status: OfferStatus;
  expiresAt: Date;
}

export type OfferAction = 'accept' | 'reject' | 'counter' | 'withdraw';

/**
 * Who may act on the latest pending offer. The counterparty accepts/rejects/counters;
 * the author may withdraw. Expired offers cannot be acted upon.
 */
export function assertOfferAction(offer: PendingOffer, actor: OfferParty, action: OfferAction, now: Date): void {
  if (offer.status !== 'pending') throw new DomainError('INVALID_STATE', 'This offer is no longer open.');
  if (now.getTime() >= offer.expiresAt.getTime()) throw new DomainError('EXPIRED', 'This offer has expired.');
  if (action === 'withdraw') {
    if (actor !== offer.fromParty) throw new DomainError('FORBIDDEN', 'Only the person who made the offer can withdraw it.');
    return;
  }
  if (actor === offer.fromParty) throw new DomainError('FORBIDDEN', 'Wait for the other person to respond to your offer.');
}

/**
 * Validates an offer amount. Offers concern item price only (shipping and fees are separate).
 * A buyer offer below the seller's private minimum is auto-declined without revealing the minimum.
 */
export function evaluateOfferAmount(args: {
  amountMinor: number;
  askingMinor: number;
  minOfferMinor: number | null;
  fromParty: OfferParty;
  previousAmountMinor?: number | null;
}): 'ok' | 'auto_decline' {
  const { amountMinor, askingMinor, minOfferMinor, fromParty } = args;
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new DomainError('VALIDATION_FAILED', 'Enter a valid offer amount.');
  }
  if (amountMinor > askingMinor) {
    throw new DomainError('VALIDATION_FAILED', 'Offers cannot be above the asking price. Buy at the listed price instead.');
  }
  if (amountMinor < Math.ceil(askingMinor * 0.2)) {
    throw new DomainError('VALIDATION_FAILED', 'This offer is too far below the asking price.');
  }
  if (fromParty === 'buyer' && minOfferMinor !== null && amountMinor < minOfferMinor) return 'auto_decline';
  return 'ok';
}
