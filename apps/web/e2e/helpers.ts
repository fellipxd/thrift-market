import { expect, type Page } from '@playwright/test';

export const DEMO_PASSWORD = 'thrift-demo-pass';

export async function signIn(page: Page, email: string, next = '/'): Promise<void> {
  await page.goto(`/sign-in?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Email or phone number').fill(email);
  await page.getByLabel('Password').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/sign-in/);
}

export async function signUpVerified(page: Page, name: string): Promise<string> {
  const email = `e2e_${Date.now()}_${Math.random().toString(36).slice(2, 6)}@example.test`;
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
