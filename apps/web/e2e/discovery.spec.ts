import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

test.describe('discovery (slice B)', () => {
  test('home feed, search with filters and keyset paging', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'New drops' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Auctions' })).toBeVisible();
    await page.goto('/search?q=linen');
    await expect(page.getByRole('heading', { name: /Results for “linen”/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Relaxed linen shirt/ }).first()).toBeVisible();
    await page.goto('/search?condition=unworn');
    await expect(page.getByRole('link', { name: 'Remove filter Unworn' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Relaxed linen shirt/ })).toHaveCount(0);
    await page.goto('/search?minPrice=9000&maxPrice=1000');
    await expect(page.getByText('We couldn’t use those filters')).toBeVisible();
  });

  test('choosing a location ranks nearby shops by approximate distance', async ({ page }) => {
    await page.goto('/nearby');
    await page.getByText(/Delivery to:/).first().click();
    await page.getByLabel('City, area or state').first().fill('Yaba');
    await page.getByRole('button', { name: 'Set' }).first().click();
    await expect(page.getByText(/Around Yaba/)).toBeVisible();
    const first = page.locator('article').first();
    await expect(first).toContainText('Yaba Vintage Drops');
    await expect(first).toContainText(/km/);
  });

  test('a buyer saves an item and finds it under Saved', async ({ page }) => {
    await signIn(page, 'buyer@demo.thrift.test', '/shops/kano-kaftan-house');
    await page.getByRole('link', { name: /Embroidered kaftan/ }).first().click();
    // Shared E2E database: another project may already have saved it for this buyer.
    const saveButton = page.getByRole('button', { name: /Save/ });
    await expect(saveButton).toBeVisible();
    if (!(await saveButton.innerText()).includes('♥')) {
      await page.getByRole('button', { name: /♡ Save/ }).click();
    }
    await expect(page.getByRole('button', { name: /♥ Saved/ })).toBeVisible();
    await page.goto('/saved');
    await expect(page.getByRole('link', { name: /Embroidered kaftan/ })).toBeVisible();
  });
});
