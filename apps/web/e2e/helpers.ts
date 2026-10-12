import { expect, type Page } from '@playwright/test';

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
