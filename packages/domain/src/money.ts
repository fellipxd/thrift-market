import { DomainError } from './errors';

export type Currency = 'NGN';

/** Integer minor units (kobo for NGN). Never use floating point for money arithmetic. */
export interface Money {
  readonly amountMinor: number;
  readonly currency: Currency;
}

export const NGN = 'NGN' as const;
export const MINOR_PER_MAJOR = 100;

export function assertMinor(amountMinor: number, field = 'amount'): number {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new DomainError('VALIDATION_FAILED', `${field} must be an integer number of minor units`, { field });
  }
  return amountMinor;
}

export function money(amountMinor: number, currency: Currency = NGN): Money {
  return { amountMinor: assertMinor(amountMinor), currency };
}

/** Parses user input like "8,500" or "8500.50" (naira) into kobo. Rejects more than 2 decimals. */
export function parseNairaToMinor(input: string | number): number {
  const raw = String(input).replace(/[₦,\s]/g, '').trim();
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(raw)) {
    throw new DomainError('VALIDATION_FAILED', 'Enter an amount in naira, e.g. 8500 or 8,500.00');
  }
  const [whole, frac = ''] = raw.split('.');
  return Number(whole) * MINOR_PER_MAJOR + Number((frac + '00').slice(0, 2));
}

export function addMoney(...amounts: number[]): number {
  return amounts.reduce((sum, a) => assertMinor(sum + assertMinor(a)), 0);
}

/** Basis-point share, rounded half-up to the nearest minor unit. 100 bps = 1%. */
export function applyBps(amountMinor: number, bps: number): number {
  assertMinor(amountMinor);
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new DomainError('VALIDATION_FAILED', 'bps must be an integer between 0 and 10000');
  }
  return Math.floor((amountMinor * bps + 5_000) / 10_000);
}

const nairaFormatter = new Intl.NumberFormat('en-NG', {
  style: 'currency',
  currency: 'NGN',
  currencyDisplay: 'narrowSymbol',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/** "₦8,500" (drops .00), "₦8,500.50" otherwise. */
export function formatNaira(amountMinor: number): string {
  assertMinor(amountMinor);
  return nairaFormatter.format(amountMinor / MINOR_PER_MAJOR);
}

export function minorToMajorString(amountMinor: number): string {
  assertMinor(amountMinor);
  const whole = Math.trunc(amountMinor / MINOR_PER_MAJOR);
  const frac = Math.abs(amountMinor % MINOR_PER_MAJOR);
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0')}`;
}
