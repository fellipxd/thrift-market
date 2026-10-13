import { expect, test } from '@playwright/test';
import { asDistinctClient, signUpVerified } from './helpers';

test.describe('account security (R01)', () => {
  test('forgot password → code → new password → sign in; the security page lists devices and changes the password', async ({ page, browser }) => {
    const email = await signUpVerified(page, 'Reset Buyer');

    const other = await browser.newContext();
    const anon = await other.newPage();
    await asDistinctClient(anon);
    await anon.goto('/sign-in');
    await anon.getByRole('link', { name: 'Forgot your password?' }).click();
    await expect(anon).toHaveURL(/\/forgot-password$/);
    await anon.waitForLoadState('networkidle');
    await anon.getByLabel('Email or phone number').fill(email);
    await anon.getByRole('button', { name: 'Send a reset code' }).click();
    await expect(anon).toHaveURL(/\/reset-password\?contact=/);
    await anon.waitForLoadState('networkidle');
    const code = (await anon.locator('strong.font-mono').innerText()).trim();
    await anon.getByLabel('Reset code').fill(code);
    await anon.getByLabel('New password').fill('a-fresh-e2e-password');
    await anon.getByRole('button', { name: 'Set new password' }).click();
    await expect(anon.getByText('Sign in with your new password.', { exact: false })).toBeVisible();
    await anon.waitForLoadState('networkidle');
    await anon.getByLabel('Email or phone number').fill(email);
    await anon.getByLabel('Password').fill('a-fresh-e2e-password');
    await anon.getByRole('button', { name: 'Sign in' }).click();
    await expect(anon).not.toHaveURL(/sign-in/);

    // The reset signed the first browser out.
    await page.goto('/account/security');
    await expect(page).toHaveURL(/sign-in/);

    await anon.goto('/account/security');
    await expect(anon.getByRole('heading', { name: 'Security', level: 1 })).toBeVisible();
    await anon.waitForLoadState('networkidle');
    await expect(anon.getByRole('list', { name: 'Signed-in devices' }).getByText('This device')).toBeVisible();
    await anon.getByLabel('Current password').fill('a-fresh-e2e-password');
    await anon.getByLabel('New password').fill('another-e2e-password');
    await anon.getByRole('button', { name: 'Change password' }).click();
    await expect(anon.getByText(/Password changed\./)).toBeVisible();
    await other.close();
  });
});
