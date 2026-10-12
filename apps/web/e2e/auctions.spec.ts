import { expect, test } from '@playwright/test';
import { signIn, signUpVerified } from './helpers';

test.describe('auctions (slice F)', () => {
  test('a guest sees the rules; a buyer reviews terms, confirms a bid and leads; the seller can no longer cancel', async ({ page, browser }) => {
    await page.goto('/auctions');
    await expect(page.getByRole('heading', { name: 'Live now' })).toBeVisible();
    await page.getByRole('link', { name: /Vintage leather shoulder bag/ }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Vintage leather shoulder bag' })).toBeVisible();
    const auctionUrl = page.url();
    expect(auctionUrl).toMatch(/\/auctions\/[0-9a-f-]{36}$/);
    await expect(page.getByText('Live', { exact: true })).toBeVisible();
    await expect(page.getByText(/A bid in the final 2 minutes extends the end to 2 minutes after that bid, up to 10 minutes in total/).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in to bid' })).toBeVisible();

    await signUpVerified(page, 'Auction Bidder');
    await page.goto(`/account/addresses?next=${encodeURIComponent(new URL(auctionUrl).pathname)}`);
    await page.getByLabel('Recipient name').fill('Auction Bidder');
    await page.getByLabel('Phone number').fill('08031234569');
    await page.getByLabel('Street address').fill('5 Admiralty Way');
    await page.getByLabel('City / town').fill('Lekki');
    await page.getByLabel('State').selectOption('Lagos');
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page).toHaveURL(auctionUrl);

    await expect(page.getByText('Delivery to Lekki, Lagos')).toBeVisible();
    const minText = await page.getByTestId('minimum-next-bid').innerText();
    const min = Number(minText.replace(/[^\d.]/g, ''));
    await page.getByLabel('Your bid (₦)').fill(String(min));
    await page.getByRole('button', { name: 'Review bid and terms' }).click();
    await expect(page.getByText(/You’re bidding ₦[\d,]+ for the item/)).toBeVisible();
    await page.getByRole('button', { name: /^Confirm bid of ₦/ }).click();
    await expect(page.getByText('You have the highest bid.').first()).toBeVisible();
    await expect(page.getByTestId('current-bid')).toHaveText(minText);
    await expect(page.getByRole('region', { name: 'Bid history' }).getByText('You').first()).toBeVisible();

    const seller = await browser.newContext();
    const sp = await seller.newPage();
    await signIn(sp, 'amina@demo.thrift.test', '/sell/auctions');
    const row = sp.getByRole('listitem').filter({ hasText: 'Vintage leather shoulder bag' });
    await expect(row).toBeVisible();
    await expect(row.getByText(/current ₦/)).toBeVisible();
    await expect(row.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
    await seller.close();
  });
});
