import { expect, test } from '@playwright/test';
import { signIn, signInStaff, signUpVerified, totpForStep } from './helpers';

test.describe('operations console and staff two-step verification', () => {
  test('non-staff never see the console', async ({ page }) => {
    await signIn(page, 'buyer@demo.thrift.test');
    const res = await page.goto('/admin');
    expect(res?.status()).toBe(404);
  });

  test('staff confirm a second factor, then change a setting that lands in the audit log', async ({ page }) => {
    await signIn(page, 'admin@demo.thrift.test', '/admin/settings');
    await expect(page).toHaveURL(/\/account\/security\/verify\?next=%2Fadmin%2Fsettings/);
    await expect(page.getByRole('heading', { name: 'Confirm it’s you' })).toBeVisible();
    await page.getByLabel('Code').fill('000000');
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByText(/didn’t match/).first()).toBeVisible();

    await signInStaff(page, 'admin@demo.thrift.test', '/admin/settings');
    await expect(page).toHaveURL(/\/admin\/settings/);
    await expect(page.getByRole('heading', { name: 'Policy settings', level: 1 })).toBeVisible();
    const row = page.getByRole('listitem').filter({ hasText: 'Delivery confirmation reminder' });
    await row.getByLabel('Value (days)').fill('3');
    await row.getByLabel('Reason').fill('E2E: confirm the reminder stays at three days');
    await row.getByRole('button', { name: 'Save' }).click();
    await expect(row.getByText('Setting saved.')).toBeVisible();

    await page.goto('/admin/audit?action=settings.updated');
    await expect(page.getByRole('heading', { name: 'Audit log', level: 1 })).toBeVisible();
    await expect(page.getByText('E2E: confirm the reminder stays at three days').first()).toBeVisible();

    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Operations overview', level: 1 })).toBeVisible();
    await expect(page.getByText(/Background worker (healthy|needs attention)/)).toBeVisible();
    await page.goto('/admin/operations');
    await expect(page.getByRole('heading', { name: 'Operations', level: 1 })).toBeVisible();
  });

  test('a newly granted staff member must set up two-step verification before using staff tools', async ({ page, browser }) => {
    const newbieContext = await browser.newContext();
    const newbie = await newbieContext.newPage();
    const email = await signUpVerified(newbie, 'New Support Agent');

    await signInStaff(page, 'admin@demo.thrift.test', '/admin/staff');
    await expect(page.getByRole('heading', { name: 'Staff access', level: 1 })).toBeVisible();
    await page.getByLabel('Account email').fill(email);
    await page.getByLabel('Role').selectOption('support');
    await page.getByLabel('Reason').first().fill('E2E: joining the support rota');
    await page.getByRole('button', { name: 'Grant' }).click();
    await expect(page.getByText(/Role granted/)).toBeVisible();

    await newbie.goto('/admin');
    await expect(newbie).toHaveURL(/\/account\/security/);
    await expect(newbie.getByText('Required for staff')).toBeVisible();
    const secret = (await newbie.getByTestId('mfa-secret').innerText()).trim();
    await newbie.getByLabel('6-digit code from your app').fill(totpForStep(secret, Math.floor(Date.now() / 30_000)));
    await newbie.getByRole('button', { name: 'Turn on two-step verification' }).click();
    await expect(newbie.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem')).toHaveCount(10);
    await newbie.getByRole('link', { name: 'Continue' }).click();
    await expect(newbie.getByRole('heading', { name: 'Operations overview', level: 1 })).toBeVisible();
    // Support can't reach admin-only pages.
    const res = await newbie.goto('/admin/settings');
    expect(res?.status()).toBe(404);
    await newbieContext.close();

    await page.reload();
    const member = page.getByRole('listitem').filter({ hasText: email });
    await member.getByLabel('Reason to revoke Support').fill('E2E: rota finished');
    await member.getByRole('button', { name: 'Revoke' }).click();
    await expect(page.getByText('Role revoked.')).toBeVisible();
  });
});
