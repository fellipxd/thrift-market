import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

/** RFC 6238 TOTP: HMAC-SHA1, 30-second steps, 6 digits (what common authenticator apps expect). */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secretB32: string, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', base32Decode(secretB32)).update(buf).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const code = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(code % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

export function timeStep(at: Date): number {
  return Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS);
}

export function totp(secretB32: string, at: Date): string {
  return hotp(secretB32, timeStep(at));
}

/**
 * Checks a code against the current step and one step either side (clock drift). Returns the matching step, or
 * null. Callers must reject steps at or before the last accepted one (replay protection).
 */
export function verifyTotp(secretB32: string, code: string, at: Date, window = 1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = timeStep(at);
  for (let d = -window; d <= window; d++) {
    const expected = hotp(secretB32, now + d);
    if (timingSafeEqualStr(expected, code)) return now + d;
  }
  return null;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function otpauthUrl(secretB32: string, account: string, issuer = 'Thrift Market'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

/** Encrypts the TOTP secret at rest with AES-256-GCM under a key derived from APP_SECRET. */
export function encryptSecret(appSecret: string, plain: string): string {
  const key = createHash('sha256').update(`${appSecret}:mfa-secret:v1`).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${enc.toString('base64url')}`;
}

export function decryptSecret(appSecret: string, stored: string): string {
  const [v, iv, tag, data] = stored.split(':');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('Unsupported MFA secret format');
  const key = createHash('sha256').update(`${appSecret}:mfa-secret:v1`).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

export function hashRecoveryCode(appSecret: string, code: string): string {
  return createHash('sha256').update(`${appSecret}:recovery:${code.toUpperCase().replace(/[^A-Z0-9]/g, '')}`).digest('hex');
}

export function generateRecoveryCodes(n = 10): string[] {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: n }, () => {
    const bytes = randomBytes(8);
    const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
    return `${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
  });
}
