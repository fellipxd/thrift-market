import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

test.describe('owned-content import (R24)', () => {
  test('a seller pastes a CSV and gets drafts to finish, with rows to fix listed', async ({ page }, info) => {
    await signIn(page, 'amina@demo.thrift.test', '/sell/import');
    await expect(page.getByRole('heading', { name: 'Import listings', level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Download the CSV template' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await page.getByText('Or paste the CSV text').click();
    const title = `Imported wrap skirt ${info.project.name}`;
    await page.getByLabel('CSV text').fill(`title,category,sale_mode,price,condition,size_system,size\n${title},Dresses,fixed,6500,good,uk,12\nNo such thing,not-a-category,fixed,100,good,uk,10`);
    await page.getByRole('button', { name: 'Import as drafts' }).click();
    await expect(page.getByText('1 draft created, 1 row need fixing.')).toBeVisible();
    await expect(page.getByText(/Unknown category "not-a-category"/)).toBeVisible();
    await page.getByRole('link', { name: 'Finish draft' }).click();
    await expect(page).toHaveURL(/\/sell\/listings\/[0-9a-f-]{36}/);
    await expect(page.getByLabel('Title')).toHaveValue(title);
  });
});
