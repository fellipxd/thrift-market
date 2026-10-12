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

/**
 * Splits a non-negative amount across non-negative integer weights by largest remainder (integer arithmetic only).
 * Shares always sum exactly to the total; equal remainders go to the earlier weight, so the split is deterministic.
 * All-zero weights split evenly.
 */
export function apportionMinor(totalMinor: number, weights: readonly number[]): number[] {
  assertMinor(totalMinor);
  if (totalMinor < 0) throw new DomainError('VALIDATION_FAILED', 'Only a non-negative amount can be apportioned');
  if (weights.length === 0) throw new DomainError('VALIDATION_FAILED', 'Apportioning needs at least one share');
  for (const w of weights) {
    if (!Number.isSafeInteger(w) || w < 0) throw new DomainError('VALIDATION_FAILED', 'Apportioning weights must be non-negative integers');
  }
  const ws = weights.some((w) => w > 0) ? weights.map(BigInt) : weights.map(() => 1n);
  const sum = ws.reduce((a, b) => a + b, 0n);
  const total = BigInt(totalMinor);
  const base = ws.map((w) => (total * w) / sum);
  const rem = ws.map((w, i) => ({ i, r: (total * w) % sum }));
  let left = Number(total - base.reduce((a, b) => a + b, 0n));
  rem.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  const shares = base.map(Number);
  for (const { i } of rem) {
    if (left <= 0) break;
    shares[i]! += 1;
    left -= 1;
  }
  return shares;
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
