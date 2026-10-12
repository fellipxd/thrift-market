import path from 'node:path';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

const fixture = (n: number) => path.join(import.meta.dirname, 'fixtures', `photo-${n}.jpg`);

test.describe('catalogue (slice A)', () => {
  test('a buyer inspects a seeded item from the shop page', async ({ page }) => {
    await page.goto('/shops/abuja-wardrobe');
    await expect(page.getByRole('heading', { level: 1, name: 'Abuja Wardrobe' })).toBeVisible();
    await expect(page.getByText(/Identity checked/).first()).toBeVisible();
    await page.getByRole('link', { name: /Relaxed linen shirt/ }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Relaxed linen shirt' })).toBeVisible();
    await expect(page.getByText('Good used')).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'Small mark on left cuff' })).toBeVisible();
    await expect(page.getByRole('link', { name: /close-up in photo/ })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Buy at listed price' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Make an offer' })).toBeVisible();
    await expect(page.getByText(/Delivery to/)).toBeVisible();
    // The private minimum is never in the page.
    expect(await page.content()).not.toContain('7,000');
  });

  test('a seller creates, photographs and publishes a listing', async ({ page }) => {
    await signIn(page, 'amina@demo.thrift.test', '/sell');
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await page.getByRole('link', { name: 'Add an item' }).first().click();
    await page.getByLabel('Category').selectOption({ label: 'Shirts & tops' });
    await page.getByLabel('Title').fill('E2E striped shirt');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'E2E striped shirt' })).toBeVisible();
    await expect(page.getByText('Before you can publish:')).toBeVisible();

    // Photos
    await page.locator('input[type="file"]').setInputFiles([fixture(1), fixture(2)]);
    await expect(page.getByText('2/12')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Save photos' }).click();
    await expect(page.getByText('Photos saved.')).toBeVisible();

    // Details
    await page.getByLabel('Size system').selectOption('intl_letter');
    await page.getByLabel('Size', { exact: true }).fill('M');
    await page.getByRole('button', { name: 'Save details' }).click();
    await expect(page.getByText('Saved.').first()).toBeVisible();

    // Condition
    await page.getByLabel(/^Excellent used/).check();
    await page.getByLabel(/no known flaws/).check();
    await page.getByRole('button', { name: 'Save condition' }).click();
    await expect(page.getByText('Saved.').first()).toBeVisible();

    // Price
    await page.getByLabel('Price (₦)').fill('6500');
    await page.getByRole('button', { name: 'Save price and delivery' }).click();
    await expect(page.getByText('Ready to publish.')).toBeVisible();

    await page.getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText(/Published/)).toBeVisible();
    await page.getByRole('link', { name: 'View public page' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'E2E striped shirt' })).toBeVisible();
    await expect(page.getByText('₦6,500').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Edit listing' })).toBeVisible();
  });
});
