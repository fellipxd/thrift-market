import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { signIn, signInStaff, signUpVerified } from './helpers';

/**
 * T16 (automated part): WCAG 2.2 A/AA rules checked with axe-core on the main buyer, seller and staff pages at phone
 * and desktop size. This catches structural problems (names, labels, contrast, landmarks, ARIA); it does not
 * replace keyboard, screen-reader and zoom review with real users.
 */
async function expectAccessible(page: Page, label: string): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const found = result.violations.map((v) => `${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`);
  expect(found, `${label}: ${page.url()}`).toEqual([]);
}

async function visit(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expectAccessible(page, path);
}

/** Presses Tab until the target has focus (keyboard-only reachability), failing after `max` presses. */
async function tabTo(page: Page, target: Locator, max = 80): Promise<void> {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
  }
  throw new Error(`Could not reach ${target} with the keyboard in ${max} Tab presses`);
}

async function expectVisibleFocus(target: Locator): Promise<void> {
  const outline = await target.evaluate((el) => {
    const s = getComputedStyle(el);
    return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
  });
  expect(outline.style).not.toBe('none');
  expect(outline.width).toBeGreaterThanOrEqual(2);
}

test.describe('accessibility checks (T16, automated)', () => {
  test('keyboard: skip link, buy path and delivery choice work without a pointer', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await expectVisibleFocus(skip);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#main$/);

    await signUpVerified(page, 'Keyboard Buyer');
    await page.goto('/account/addresses');
    await page.getByLabel('Recipient name').fill('Keyboard Buyer');
    await page.getByLabel('Phone number').fill('08031230002');
    await page.getByLabel('Street address').fill('8 Broad Street');
    await page.getByLabel('City / town').fill('Lagos Island');
    await page.getByLabel('State').selectOption('Lagos');
    await page.getByRole('button', { name: 'Save address' }).click();
    await expect(page.getByText('Address saved.')).toBeVisible();

    await page.goto('/shops/abuja-wardrobe');
    await page.getByRole('link', { name: /Plain white tees/ }).first().click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const buy = page.getByRole('link', { name: 'Buy at listed price' });
    await tabTo(page, buy);
    await expectVisibleFocus(buy);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Review and pay' })).toBeVisible();

    // Delivery options form one radio group: arrow keys move the choice (and the total shown with it).
    const radios = page.getByRole('radio');
    await tabTo(page, radios.first());
    await expect(radios.first()).toBeChecked();
    await page.keyboard.press('ArrowDown');
    await expect(radios.nth(1)).toBeChecked();
    await expect(radios.nth(1)).toBeFocused();
    const pay = page.getByRole('button', { name: 'Continue to payment' });
    await tabTo(page, pay, 20);
    await expectVisibleFocus(pay);
  });


  test('public pages', async ({ page }) => {
    for (const path of ['/', '/search', '/search?q=shirt&sort=newest', '/shops/abuja-wardrobe', '/auctions', '/nearby', '/help', '/sign-in', '/sign-up']) await visit(page, path);
    await page.goto('/shops/abuja-wardrobe');
    await page.getByRole('link', { name: /Relaxed linen shirt/ }).first().click();
    await expectAccessible(page, 'item page');
    await page.goto('/auctions');
    await page.locator('a[href^="/auctions/"]').first().click();
    await expectAccessible(page, 'auction page');
  });

  test('buyer pages: bag, checkout, payment, order, chat and offer', async ({ page }) => {
    await signUpVerified(page, 'Access Buyer');
    await page.goto('/account/addresses');
    await expectAccessible(page, 'addresses');
    await page.getByLabel('Recipient name').fill('Access Buyer');
    await page.getByLabel('Phone number').fill('08031230001');
    await page.getByLabel('Street address').fill('2 Marina Road');
    await page.getByLabel('City / town').fill('Lagos Island');
    await page.getByLabel('State').selectOption('Lagos');
    await page.getByRole('button', { name: 'Save address' }).click();
    await expect(page.getByText('Address saved.')).toBeVisible();
    for (const path of ['/account', '/account/notifications', '/notifications', '/saved', '/orders', '/inbox', '/bag']) await visit(page, path);

    // Bag and bag checkout (nothing is held until “Continue”, which this test never presses).
    await page.goto('/shops/abuja-wardrobe');
    await page.getByRole('link', { name: /Plain white tees/ }).first().click();
    await expectAccessible(page, 'item page (signed in)');
    await page.getByRole('button', { name: 'Add to bag' }).click();
    await expect(page.getByRole('link', { name: 'In your bag — view bag' })).toBeVisible();
    await visit(page, '/bag');
    await page.getByRole('link', { name: 'Check out from this shop' }).first().click();
    await expectAccessible(page, 'bag checkout');

    // Single checkout → provider page → pending payment page → cancel (releases the hold) → order page.
    await page.goto('/shops/abuja-wardrobe');
    await page.getByRole('link', { name: /Plain white tees/ }).first().click();
    await page.getByRole('link', { name: 'Buy at listed price' }).click();
    await expectAccessible(page, 'checkout');
    await page.getByRole('button', { name: 'Continue to payment' }).click();
    await expect(page.getByRole('heading', { name: 'Sandbox payment page' })).toBeVisible();
    await expectAccessible(page, 'sandbox payment page');
    await page.goto('/orders');
    await page.getByRole('link', { name: /Plain white tees/ }).first().click();
    await expectAccessible(page, 'order (awaiting payment)');
    await page.getByRole('link', { name: 'Complete payment' }).click();
    await expectAccessible(page, 'complete payment');
    await page.getByRole('button', { name: 'Cancel this order' }).click();
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);
    await expectAccessible(page, 'order (cancelled)');

    // Chat and offer form on a negotiable piece.
    await page.goto('/shops/kano-kaftan-house');
    await page.getByRole('link', { name: /Classic analogue watch/ }).first().click();
    await page.getByRole('link', { name: 'Message seller' }).click();
    await expect(page).toHaveURL(/\/inbox\/[0-9a-f-]{36}/);
    await expectAccessible(page, 'conversation');
    await page.goBack();
    await page.getByRole('link', { name: 'Make an offer' }).click();
    await expectAccessible(page, 'offer form');
  });

  test('seller workspace pages', async ({ page }) => {
    await signIn(page, 'amina@demo.thrift.test', '/sell');
    for (const path of ['/sell', '/sell/listings', '/sell/listings/new', '/sell/batches', '/sell/orders?filter=all', '/sell/offers', '/sell/auctions', '/sell/payouts', '/sell/insights', '/sell/promotions', '/sell/reviews', '/sell/settings', '/sell/verification']) {
      await visit(page, path);
    }
    await page.goto('/sell/listings');
    await page.locator('a[href^="/sell/listings/"][href$="-"], a[href^="/sell/listings/"]').filter({ hasNotText: /New|Batch/ }).first().click();
    await expectAccessible(page, 'listing editor');
  });

  test('staff console pages', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'The staff console is checked once (desktop) to keep two-step sign-ins few.');
    await signInStaff(page, 'admin@demo.thrift.test', '/admin');
    for (const path of ['/admin', '/admin/operations', '/admin/finance', '/admin/reports', '/admin/disputes', '/admin/reviews', '/admin/ads', '/admin/verification', '/admin/categories', '/admin/settings', '/admin/staff', '/admin/audit']) {
      await visit(page, path);
    }
  });
});
