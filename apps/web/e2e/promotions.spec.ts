import { expect, test } from '@playwright/test';
import { asDistinctClient, signIn, signInStaff } from './helpers';

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test.describe('paid promotion and seller insights (slice H2)', () => {
  test('a seller books and pays; staff approve; shoppers see it labelled “Sponsored” and the click is counted', async ({ page, browser }) => {
    await signIn(page, 'amina@demo.thrift.test', '/sell/promotions');
    await expect(page.getByRole('heading', { name: 'Promotions', level: 1 })).toBeVisible();
    const card = page.getByRole('listitem').filter({ hasText: 'Search results · 7 days' });
    const select = card.getByLabel('Item to promote');
    // Items that already have this placement booked aren't offered, so each run takes the first eligible item.
    const title = ((await select.locator('option').nth(1).textContent()) ?? '').trim();
    await select.selectOption({ index: 1 });
    await card.getByRole('button', { name: /Book and pay/ }).click();
    await expect(page).toHaveURL(/\/sandbox\/pay\//);
    await page.getByRole('button', { name: 'Simulate successful payment' }).click();
    await expect(page).toHaveURL(/\/sell\/promotions\?payment=(paid|already_applied)/);
    await expect(page.getByText('Payment confirmed. Your promotion is now waiting for review.')).toBeVisible();
    const row = page.getByTestId('promotion-row').filter({ hasText: title }).first();
    await expect(row.getByText('Paid · in review')).toBeVisible();

    const staffContext = await browser.newContext();
    const admin = await staffContext.newPage();
    await signInStaff(admin, 'admin@demo.thrift.test', '/admin/ads');
    const pending = admin.getByTestId('staff-promotion').filter({ hasText: title }).first();
    await pending.getByLabel('Decision').selectOption('approve');
    await pending.getByLabel('Reason (shared with the seller)').fill('Clear photos and an honest description.');
    await pending.getByRole('button', { name: 'Apply' }).click();
    await expect(admin.getByText('Approved — the promotion is live.')).toBeVisible();
    await staffContext.close();

    const shopperContext = await browser.newContext({ userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36' });
    const shopper = await shopperContext.newPage();
    await asDistinctClient(shopper);
    await shopper.goto(`/search?q=${encodeURIComponent(title)}`);
    const sponsored = shopper.getByRole('region', { name: 'Sponsored' });
    const promoted = sponsored.getByRole('link', { name: new RegExp(escape(title)) }).first();
    await expect(promoted).toBeVisible();
    await expect(promoted.getByText('Sponsored')).toBeVisible();
    await promoted.click();
    await expect(shopper).toHaveURL(/\/items\/[0-9a-f-]{36}$/);
    await expect(shopper.getByRole('heading', { name: title, level: 1 })).toBeVisible();
    await shopperContext.close();

    await page.goto('/sell/promotions');
    const live = page.getByTestId('promotion-row').filter({ hasText: title }).first();
    await expect(live.getByText('Live', { exact: true })).toBeVisible();
    const stats = live.locator('dd');
    await expect(stats.nth(0)).toHaveText('1');
    await expect(stats.nth(1)).toHaveText('1');
  });

  test('seller insights show the period’s engagement, sales and top items', async ({ page }) => {
    await signIn(page, 'amina@demo.thrift.test', '/sell/insights');
    await expect(page.getByRole('heading', { name: 'Insights', level: 1 })).toBeVisible();
    await expect(page.getByText('Item views')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Top items' })).toBeVisible();
    await page.getByRole('link', { name: 'Last 7 days' }).click();
    await expect(page).toHaveURL(/days=7/);
    await expect(page.getByRole('link', { name: 'Last 7 days' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('list', { name: 'Daily item views' }).getByRole('listitem')).toHaveCount(7);
  });
});
