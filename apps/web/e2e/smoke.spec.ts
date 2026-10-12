import { expect, test } from '@playwright/test';
import { signUpVerified } from './helpers';

test('home renders with sandbox notice and navigation', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Sandbox mode')).toBeVisible();
  await expect(page.getByRole('search').first()).toBeVisible();
});

test('a new buyer can sign up and verify their contact', async ({ page }) => {
  await signUpVerified(page, 'E2E Buyer');
  await page.goto('/account');
  await expect(page.getByText('Contact verified')).toBeVisible();
});
