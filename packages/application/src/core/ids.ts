import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** URL-safe random token (base64url). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Payment references are unique, unguessable and safe to show on receipts. */
export function paymentReference(prefix = 'TMP'): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(6).toString('hex')}`;
}

export function hmacHex(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

/** Constant-time check of a hex HMAC (never compare signatures with ===). */
export function hmacHexMatches(secret: string, value: string, candidate: string): boolean {
  const expected = Buffer.from(hmacHex(secret, value), 'hex');
  const given = /^[0-9a-f]+$/i.test(candidate) ? Buffer.from(candidate, 'hex') : Buffer.alloc(0);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
