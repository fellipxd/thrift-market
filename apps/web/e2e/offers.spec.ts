import { expect, test } from '@playwright/test';
import { signIn, signUpVerified } from './helpers';

// Each browser project negotiates on a different seeded unique piece so runs don't contend with each other.
const PLAN = {
  mobile: { shop: 'yaba-vintage-drops', item: /Denim trucker jacket/, low: '12000', ok: '16000', okLabel: '₦16,000', seller: 'tunde@demo.thrift.test' },
  desktop: { shop: 'kano-kaftan-house', item: /Classic analogue watch/, low: '9000', ok: '13000', okLabel: '₦13,000', seller: 'musa@demo.thrift.test' },
} as const;

test.describe('chat and offers (slice E)', () => {
  test('buyer offers, chats, seller accepts, buyer continues to checkout at the agreed price', async ({ page, browser }, info) => {
    const plan = PLAN[info.project.name as keyof typeof PLAN] ?? PLAN.desktop;
    await signUpVerified(page, 'Offer Buyer');
    await page.goto(`/shops/${plan.shop}`);
    await page.getByRole('link', { name: plan.item }).first().click();
    await page.getByRole('link', { name: 'Make an offer' }).click();
    await expect(page.getByText('An offer doesn’t hold the item.', { exact: false })).toBeVisible();

    // Below the seller's private minimum: declined without revealing the minimum.
    await page.getByLabel('Your offer (₦)').fill(plan.low);
    await page.getByRole('button', { name: 'Send offer' }).click();
    await expect(page.getByText('This offer is below what the seller will accept. Try a higher amount.').first()).toBeVisible();

    await page.getByLabel('Your offer (₦)').fill(plan.ok);
    await page.getByLabel('Note to the seller (optional)').fill('Can pay today');
    await page.getByRole('button', { name: 'Send offer' }).click();
    await expect(page).toHaveURL(/\/inbox\/[0-9a-f-]{36}/);
    await expect(page.getByText('Offer sent. It doesn’t hold the item until the seller accepts it.')).toBeVisible();
    // Both offers appear as cards: the auto-declined one and the one waiting for the seller.
    await expect(page.getByText('You offered')).toHaveCount(2);
    await expect(page.getByText('Declined automatically', { exact: true })).toBeVisible();
    await expect(page.getByText('Waiting for a reply')).toBeVisible();
    await expect(page.getByText(plan.okLabel).first()).toBeVisible();
    const conversationUrl = page.url();

    await page.getByRole('textbox', { name: 'Write a message' }).fill('Is there any damage I should know about?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Is there any damage I should know about?')).toBeVisible();

    // Seller reviews and accepts from the offers page, then replies in the conversation.
    const sellerContext = await browser.newContext();
    const seller = await sellerContext.newPage();
    await signIn(seller, plan.seller, '/sell/offers');
    await expect(seller.getByRole('heading', { name: 'Offers & chat' })).toBeVisible();
    const card = seller.getByRole('listitem').filter({ hasText: plan.okLabel }).filter({ hasText: 'Offer Buyer' });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Accept' }).click();
    await expect(seller.getByText('Offer accepted. The piece is reserved for the buyer while they pay.')).toBeVisible();
    await seller.goto(conversationUrl);
    await expect(seller.getByText('Is there any damage I should know about?')).toBeVisible();
    await seller.getByRole('textbox', { name: 'Write a message' }).fill('No damage at all, it is in great shape.');
    await seller.getByRole('button', { name: 'Send' }).click();
    await expect(seller.getByText('No damage at all, it is in great shape.')).toBeVisible();
    await sellerContext.close();

    // The buyer's open conversation picks up the reply and the acceptance by polling.
    await expect(page.getByText('No damage at all, it is in great shape.')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('link', { name: 'Continue to checkout' })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('link', { name: 'Continue to checkout' }).click();
    await expect(page.getByRole('heading', { name: 'Review and pay' })).toBeVisible();
    await expect(page.getByText(plan.okLabel).first()).toBeVisible();
    await expect(page.getByText('agreed price')).toBeVisible();
  });
});
