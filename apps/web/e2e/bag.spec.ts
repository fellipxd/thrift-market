import { expect, test } from '@playwright/test';
import { signUpVerified } from './helpers';

/** Each project buys two different untouched unique pieces from one shop, so the runs never compete. */
const PICK = {
  mobile: { shop: '/shops/abuja-wardrobe', shopName: 'Abuja Wardrobe', items: ['Green midi wrap dress', 'Striped cotton shirt'] },
  desktop: { shop: '/shops/yaba-vintage-drops', shopName: 'Yaba Vintage Drops', items: ['High-waist mom jeans', 'Corduroy bucket hat'] },
} as const;

test.describe('same-seller bag checkout (doc 06)', () => {
  test('a buyer bags two pieces from one shop, pays once and gets one order for both', async ({ page }, info) => {
    const pick = PICK[info.project.name as keyof typeof PICK];
    await signUpVerified(page, 'Bag Buyer');
    await page.goto('/account/addresses');
    await page.getByLabel('Recipient name').fill('Bag Buyer');
    await page.getByLabel('Phone number').fill('08031239876');
    await page.getByLabel('Street address').fill('4 Admiralty Way');
    await page.getByLabel('City / town').fill('Lekki');
    await page.getByLabel('State').selectOption('Lagos');
    await page.getByRole('button', { name: 'Save address' }).click();
    await expect(page.getByText('Address saved.')).toBeVisible();

    for (const title of pick.items) {
      await page.goto(pick.shop);
      await page.getByRole('link', { name: new RegExp(title) }).first().click();
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      await expect(page.getByText(/Your bag doesn’t hold pieces/)).toBeVisible();
      await page.getByRole('button', { name: 'Add to bag' }).click();
      await expect(page.getByRole('link', { name: 'In your bag — view bag' })).toBeVisible();
    }

    await page.getByRole('link', { name: 'Bag, 2 pieces' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Bag' })).toBeVisible();
    const group = page.getByTestId('bag-shop').filter({ hasText: pick.shopName });
    await expect(group.getByTestId('bag-item')).toHaveCount(2);
    await group.getByRole('link', { name: 'Check out from this shop' }).click();

    await expect(page.getByRole('heading', { name: 'Review and pay' })).toBeVisible();
    const pieces = page.getByRole('list', { name: 'Pieces in this order' });
    for (const title of pick.items) await expect(pieces.getByRole('link', { name: title })).toBeVisible();
    await expect(page.getByText('Delivery — one parcel')).toBeVisible();
    await expect(page.getByText(/every piece is held for you together for 10 minutes/)).toBeVisible();
    await page.getByRole('button', { name: 'Continue to payment' }).click();
    await expect(page.getByRole('heading', { name: 'Sandbox payment page' })).toBeVisible();
    await page.getByRole('button', { name: 'Simulate successful payment' }).click();

    await expect(page.getByText('Payment confirmed. The seller has been told to dispatch your order.')).toBeVisible();
    const ordered = page.locator('section').filter({ has: page.getByRole('heading', { name: 'What was ordered' }) });
    for (const title of pick.items) await expect(ordered.getByRole('link', { name: title })).toBeVisible();
    const orderNumber = (await page.getByText(/^Order TM\d+/).first().innerText()).match(/TM\d+/)![0];

    await page.goto('/orders');
    await expect(page.getByRole('link', { name: new RegExp(orderNumber) })).toContainText('and 1 more');
    // Bought pieces leave the bag.
    await page.goto('/bag');
    await expect(page.getByText('Your bag is empty', { exact: true })).toBeVisible();
  });
});
