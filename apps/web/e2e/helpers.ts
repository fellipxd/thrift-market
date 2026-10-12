import { expect, type Page } from '@playwright/test';
import { createHmac } from 'node:crypto';

export const DEMO_PASSWORD = 'thrift-demo-pass';

/**
 * Each E2E session presents as a distinct client (documentation-range IP via the proxy header the app reads), so
 * the suite doesn't trip the per-IP sign-up and sign-in rate limits that protect production.
 */
export async function asDistinctClient(page: Page): Promise<void> {
  const n = () => Math.floor(Math.random() * 250) + 1;
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `10.${n()}.${n()}.${n()}` });
}

export async function signIn(page: Page, email: string, next = '/'): Promise<void> {
  await asDistinctClient(page);
  await page.goto(`/sign-in?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Email or phone number').fill(email);
  await page.getByLabel('Password').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/sign-in/);
}

export async function signUpVerified(page: Page, name: string): Promise<string> {
  const email = `e2e_${Date.now()}_${Math.random().toString(36).slice(2, 6)}@example.test`;
  await asDistinctClient(page);
  await page.goto('/sign-up');
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Email or Nigerian mobile number').fill(email);
  await page.getByLabel('Password').fill('a-long-e2e-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/verify/);
  const code = await page.locator('strong.font-mono').innerText();
  await page.getByLabel('Verification code').fill(code);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).not.toHaveURL(/verify/);
  return email;
}

/** Dev-only two-step secret the demo seed enrols for demo staff (never used outside local/E2E databases). */
export const DEMO_STAFF_MFA_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of input.replace(/=+$/, '').toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 code (SHA-1, 30-second steps, 6 digits) for a step number. */
export function totpForStep(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 1_000_000).padStart(6, '0');
}

/**
 * Signs a demo staff member in and completes the two-step check. Codes are single use per step, so when this
 * step's (and the next step's) code has already been spent by an earlier sign-in, wait for the next step.
 */
export async function signInStaff(page: Page, email: string, next = '/admin'): Promise<void> {
  await signIn(page, email, next);
  // A fresh session always needs the second factor; the redirect to the check can land after the first navigation.
  await page.waitForURL(/\/account\/security\/verify/, { timeout: 15_000 });
  for (let attempt = 0; attempt < 6; attempt++) {
    const step = Math.floor(Date.now() / 30_000) + (attempt % 2);
    await page.getByLabel('Code').fill(totpForStep(DEMO_STAFF_MFA_SECRET, step));
    const response = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/account/security/verify');
    await page.getByRole('button', { name: 'Verify' }).click();
    await response;
    try {
      await page.waitForURL((u) => !u.pathname.startsWith('/account/security/verify'), { timeout: 10_000 });
      return;
    } catch {
      // Code already spent by an earlier sign-in this step: try the next step's code, then wait for a fresh one.
    }
    if (attempt % 2 === 1) await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 500);
  }
  throw new Error('Could not complete the staff two-step check');
}
