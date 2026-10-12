import { expect, test, type Page } from '@playwright/test';
import { signIn, signUpVerified } from './helpers';

/** A new buyer buys one of the identical tees with the platform courier and pays on the sandbox page. */
async function buyTeeWithCourier(page: Page, name: string): Promise<string> {
  await signUpVerified(page, name);
  await page.goto('/account/addresses');
  await page.getByLabel('Recipient name').fill(name);
  await page.getByLabel('Phone number').fill('08031230000');
  await page.getByLabel('Street address').fill('9 Awolowo Road');
  await page.getByLabel('City / town').fill('Ikoyi');
  await page.getByLabel('State').selectOption('Lagos');
  await page.getByRole('button', { name: 'Save address' }).click();
  await expect(page.getByText('Address saved.')).toBeVisible();
  await page.goto('/shops/abuja-wardrobe');
  await page.getByRole('link', { name: /Plain white tees/ }).first().click();
  await page.getByRole('link', { name: 'Buy at listed price' }).click();
  await page.getByRole('radio', { name: /Platform courier/ }).check();
  await page.getByRole('button', { name: 'Continue to payment' }).click();
  await page.getByRole('button', { name: 'Simulate successful payment' }).click();
  await expect(page.getByText('Payment confirmed.', { exact: false }).first()).toBeVisible();
  return page.url().split('?')[0]!;
}

test.describe('fulfilment and disputes (slice D)', () => {
  test('courier booking, signed milestones, buyer-visible tracking, then a dispute settled by a partial refund', async ({ page, browser }) => {
    const orderUrl = await buyTeeWithCourier(page, 'Tracking Buyer');
    const orderId = orderUrl.split('/').pop()!;

    const sellerContext = await browser.newContext();
    const seller = await sellerContext.newPage();
    await signIn(seller, 'amina@demo.thrift.test', `/sell/orders/${orderId}`);
    await seller.getByRole('button', { name: 'Book courier' }).click();
    await expect(seller.getByText(/Dispatched\. Tracking reference SBX-TM\d+/)).toBeVisible();
    // The courier's tracking page opens in a new tab; follow its address directly.
    await seller.goto((await seller.getByRole('link', { name: 'Open courier tracking' }).getAttribute('href'))!);
    await expect(seller.getByRole('heading', { name: 'Sandbox courier console' })).toBeVisible();
    await seller.getByRole('button', { name: 'Picked up' }).click();
    await expect(seller.getByText('Milestone sent.')).toBeVisible();
    await seller.getByRole('button', { name: 'Delivered' }).click();
    await expect(seller.getByText(/current status delivered/)).toBeVisible();

    await page.goto(orderUrl);
    await expect(page.getByText('Verified by courier').first()).toBeVisible();
    await expect(page.getByText('Delivered (courier scan)').first()).toBeVisible();
    await expect(page.getByText('Milestone tracking, not live GPS.', { exact: true })).toBeVisible();

    // The buyer reports an undisclosed flaw instead of confirming.
    await page.getByLabel('What went wrong?').selectOption('undisclosed_defect');
    await page.getByLabel('Describe the problem').fill('There is a yellow stain on the collar that was not in the photos.');
    await page.getByRole('button', { name: 'Report a problem' }).click();
    await expect(page.getByText('Waiting for the seller')).toBeVisible();

    await seller.goto(`/sell/orders/${orderId}`);
    await expect(seller.getByText('The buyer reported a problem')).toBeVisible();
    await seller.getByLabel('Offer a partial refund').check();
    await seller.getByLabel('Partial refund (₦)').fill('500');
    await seller.getByLabel('Message and explanation').fill('Sorry about that — here is something back.');
    await seller.getByRole('button', { name: 'Send response' }).click();
    await expect(seller.getByText('Waiting for the buyer')).toBeVisible();
    await sellerContext.close();

    await page.goto(orderUrl);
    await page.getByRole('button', { name: 'Accept ₦500' }).click();
    await expect(page.getByText(/Outcome: partial refund · ₦500/)).toBeVisible();
  });

  test('staff see the dispute queue and deliveries needing review', async ({ page }) => {
    await signIn(page, 'admin@demo.thrift.test', '/admin/disputes');
    await expect(page.getByRole('heading', { name: 'Disputes', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Deliveries needing review/ })).toBeVisible();
    await page.goto('/admin/disputes?status=all');
    await expect(page.getByText(/Flaw or damage that wasn’t disclosed/).first()).toBeVisible();
  });
});
