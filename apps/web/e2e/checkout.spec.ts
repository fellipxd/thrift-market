import { expect, test } from '@playwright/test';
import { signIn, signUpVerified } from './helpers';

test.describe('checkout (slice C)', () => {
  test('a buyer adds an address, pays on the sandbox page and the seller sees the paid order', async ({ page, browser }) => {
    await signUpVerified(page, 'Checkout Buyer');
    // Equivalent-unit stock (5 identical tees), so the mobile and desktop runs can each buy one.
    await page.goto('/shops/abuja-wardrobe');
    await page.getByRole('link', { name: /Plain white tees/ }).first().click();
    await page.getByRole('link', { name: 'Buy at listed price' }).click();
    await expect(page.getByRole('heading', { name: 'Review and pay' })).toBeVisible();

    // No address yet: add one and come straight back to checkout.
    await page.getByRole('link', { name: 'Add address' }).click();
    await page.getByLabel('Recipient name').fill('Checkout Buyer');
    await page.getByLabel('Phone number').fill('08031234567');
    await page.getByLabel('Street address').fill('12 Allen Avenue');
    await page.getByLabel('City / town').fill('Ikeja');
    await page.getByLabel('State').selectOption('Lagos');
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page.getByRole('heading', { name: 'Review and pay' })).toBeVisible();
    await expect(page.getByText('12 Allen Avenue, Ikeja, Lagos')).toBeVisible();

    // Delivery options with totals, then reserve and go to the (clearly labelled) sandbox provider page.
    await expect(page.getByRole('radio').first()).toBeChecked();
    await expect(page.getByText(/held for you for 10 minutes/)).toBeVisible();
    await page.getByRole('button', { name: 'Continue to payment' }).click();
    await expect(page.getByRole('heading', { name: 'Sandbox payment page' })).toBeVisible();
    await expect(page.getByText('SIMULATION')).toBeVisible();
    await page.getByRole('button', { name: 'Simulate successful payment' }).click();

    await expect(page.getByText('Payment confirmed. The seller has been told to dispatch your order.')).toBeVisible();
    await expect(page.getByText('Paid', { exact: true }).first()).toBeVisible();
    const eyebrow = await page.getByText(/^Order TM\d+/).first().innerText();
    const orderNumber = eyebrow.match(/TM\d+/)![0];

    await page.goto('/orders');
    await expect(page.getByText(orderNumber)).toBeVisible();

    const seller = await browser.newContext();
    const sellerPage = await seller.newPage();
    await signIn(sellerPage, 'amina@demo.thrift.test', '/sell/orders');
    await expect(sellerPage.getByRole('heading', { name: 'Orders' })).toBeVisible();
    await sellerPage.getByRole('link', { name: new RegExp(orderNumber) }).click();
    await expect(sellerPage.getByText('Ready to ship')).toBeVisible();
    await expect(sellerPage.getByText('12 Allen Avenue')).toBeVisible();
    await expect(sellerPage.getByRole('button', { name: 'Cancel and refund buyer' })).toBeVisible();
    await seller.close();
  });

  test('a declined payment can be retried while the hold lasts, or the order cancelled', async ({ page }) => {
    await signUpVerified(page, 'Retry Buyer');
    await page.goto('/account/addresses');
    await page.getByLabel('Recipient name').fill('Retry Buyer');
    await page.getByLabel('Phone number').fill('08031234568');
    await page.getByLabel('Street address').fill('3 Wuse Close');
    await page.getByLabel('City / town').fill('Abuja');
    await page.getByLabel('State').selectOption('FCT');
    await page.getByRole('button', { name: 'Save address' }).click();
    await expect(page.getByText('Address saved.')).toBeVisible();

    await page.goto('/shops/abuja-wardrobe');
    await page.getByRole('link', { name: /Plain white tees/ }).first().click();
    await page.getByRole('link', { name: 'Buy at listed price' }).click();
    await page.getByRole('button', { name: 'Continue to payment' }).click();
    await page.getByRole('button', { name: 'Simulate declined payment' }).click();
    await expect(page.getByRole('heading', { name: 'Complete your payment' })).toBeVisible();
    await expect(page.getByText('Payment not completed')).toBeVisible();
    await page.getByRole('button', { name: 'Try payment again' }).click();
    await expect(page.getByRole('heading', { name: 'Sandbox payment page' })).toBeVisible();
    await page.getByRole('button', { name: 'Close without paying' }).click();
    await expect(page.getByRole('heading', { name: 'Complete your payment' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel this order' }).click();
    await expect(page.getByText('You cancelled this order before paying.')).toBeVisible();
  });
});
