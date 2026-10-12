import { createHmac, randomBytes } from 'node:crypto';

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
