import { expect, test } from '@playwright/test';
import { signIn, signUpVerified } from './helpers';

// Each browser project buys a different unique piece from the same shop (PH Sole Republic, seller ebi).
const PLAN = {
  mobile: { item: /Woven leather belt/ },
  desktop: { item: /Black block heels/ },
} as const;

test.describe('trust and growth (slice G)', () => {
  test('a buyer reviews a delivered purchase and it appears on the shop’s reviews with the sample size', async ({ page, browser }, info) => {
    const plan = PLAN[info.project.name as keyof typeof PLAN] ?? PLAN.desktop;
    await signUpVerified(page, 'Review Buyer');
    await page.goto('/account/addresses');
    await page.getByLabel('Recipient name').fill('Review Buyer');
    await page.getByLabel('Phone number').fill('08031230001');
    await page.getByLabel('Street address').fill('1 Marina Road');
    await page.getByLabel('City / town').fill('Lagos Island');
    await page.getByLabel('State').selectOption('Lagos');
    await page.getByRole('button', { name: 'Save address' }).click();
    await expect(page.getByText('Address saved.')).toBeVisible();

    await page.goto('/shops/ph-sole-republic');
    await page.getByRole('link', { name: plan.item }).first().click();
    await page.getByRole('link', { name: 'Buy at listed price' }).click();
    await page.getByRole('radio', { name: /Seller-arranged delivery/ }).check();
    await page.getByRole('button', { name: 'Continue to payment' }).click();
    await page.getByRole('button', { name: 'Simulate successful payment' }).click();
    await expect(page.getByText('Payment confirmed.', { exact: false }).first()).toBeVisible();
    const orderUrl = page.url().split('?')[0]!;
    const orderId = orderUrl.split('/').pop()!;

    const sellerContext = await browser.newContext();
    const seller = await sellerContext.newPage();
    await signIn(seller, 'ebi@demo.thrift.test', `/sell/orders/${orderId}`);
    await seller.getByLabel('Delivered by (rider or company)').fill('GIG Logistics');
    await seller.getByRole('button', { name: 'Mark as dispatched' }).click();
    await expect(seller.getByText('Marked as dispatched.', { exact: false })).toBeVisible();
    await seller.getByRole('button', { name: 'Mark as delivered' }).click();
    await expect(seller.getByText('Marked as delivered.', { exact: false })).toBeVisible();
    await sellerContext.close();

    await page.goto(orderUrl);
    await expect(page.getByText('Reported by seller').first()).toBeVisible();
    await page.getByRole('button', { name: 'I have received it' }).click();
    await expect(page.getByText('You confirmed you received this order.')).toBeVisible();

    for (const group of ['Overall', 'Condition as described', 'Communication', 'Delivery']) {
      await page.getByRole('group', { name: group }).getByText('5', { exact: true }).click();
    }
    await page.getByLabel('Your review (optional)').fill('Exactly as described and well packed.');
    await page.getByRole('button', { name: 'Post review' }).click();
    await expect(page.getByText('Verified purchase').first()).toBeVisible();

    await page.goto('/shops/ph-sole-republic/reviews');
    await expect(page.getByRole('heading', { name: 'Reviews', level: 1 })).toBeVisible();
    await expect(page.getByText(/\d+ reviews? from \d+ completed orders?/)).toBeVisible();
    await expect(page.getByText('Exactly as described and well packed.').first()).toBeVisible();
  });

  test('reports reach trust & safety, and notification settings respect opt-in', async ({ page, browser }) => {
    await signUpVerified(page, 'Reporting Buyer');
    await page.goto('/shops/kano-kaftan-house');
    await page.getByRole('link', { name: /Embroidered kaftan/ }).first().click();
    await page.getByRole('link', { name: 'Report this listing' }).click();
    await expect(page.getByRole('heading', { name: 'Report a problem' })).toBeVisible();
    await page.getByLabel('What’s wrong?').selectOption('misleading');
    await page.getByLabel('Details (optional)').fill('The photos look like a different garment.');
    await page.getByRole('button', { name: 'Send report' }).click();
    await expect(page.getByText('our trust & safety team will review this', { exact: false })).toBeVisible();

    await page.goto('/account/notifications');
    await expect(page.getByRole('checkbox', { name: 'New drops from shops you follow by In app' })).not.toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Orders and account by In app' })).toBeDisabled();
    await page.getByRole('checkbox', { name: 'New drops from shops you follow by In app' }).check();
    await page.getByRole('button', { name: 'Save preferences' }).click();
    await expect(page.getByText('Preferences saved.')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('checkbox', { name: 'New drops from shops you follow by In app' })).toBeChecked();

    const staff = await browser.newContext();
    const admin = await staff.newPage();
    await signIn(admin, 'admin@demo.thrift.test', '/admin/reports');
    const row = admin.getByRole('listitem').filter({ hasText: 'The photos look like a different garment.' }).first();
    await expect(row).toBeVisible();
    await row.getByLabel('Action').selectOption('dismiss');
    await row.getByLabel('Reason (shared with the affected person)').fill('Photos match the item on inspection.');
    await row.getByRole('button', { name: 'Apply' }).click();
    await expect(admin.getByText('Done.', { exact: false })).toBeVisible();
    await admin.goto('/notifications');
    await expect(admin.getByRole('heading', { name: 'Notifications' })).toBeVisible();
    await staff.close();
  });
});
