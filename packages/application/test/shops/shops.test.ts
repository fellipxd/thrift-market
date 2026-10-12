import { afterAll, describe, expect, it } from 'vitest';
import {
  addOrReplacePayoutAccount,
  createShop,
  decideVerification,
  getShopStorefront,
  publishShop,
  submitVerification,
  updateDeliveryCoverage,
} from '../../src';
import { closeTestServices, createUser, testServices } from '../support';
import { insertMedia } from '../catalogue/helpers';

afterAll(closeTestServices);

const profile = (name: string) => ({ name, bio: 'Hand-picked pieces', state: 'Lagos', city: 'Lagos', area: 'Yaba', dispatchDays: '2', returnsPolicy: 'Returns accepted for undisclosed defects within 3 days.' });
const coverage = { scope: 'national', states: '', excludedStates: '', offersPickup: 'false', offersSellerArranged: 'true', offersIntegrated: 'true', sameCityFee: '1500', sameStateFee: '2500', interstateFee: '4500', transitDaysMin: '1', transitDaysMax: '5', pickupNote: '' };

describe('shops', () => {
  it('requires a verified contact and allows one shop per seller', async () => {
    const unverified = await createUser({ verified: false });
    await expect(createShop(unverified.ctx, profile('Unverified Shop'))).rejects.toMatchObject({ code: 'CONTACT_UNVERIFIED' });
    const seller = await createUser();
    const { slug } = await createShop(seller.ctx, profile('Yaba Gems'));
    expect(slug).toMatch(/^yaba-gems/);
    await expect(createShop(seller.ctx, profile('Second Shop'))).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('allocates distinct slugs for shops with the same name and stores only an approximate location', async () => {
    const a = await createUser();
    const b = await createUser();
    const s1 = await createShop(a.ctx, profile('Same Name Closet'));
    const s2 = await createShop(b.ctx, profile('Same Name Closet'));
    expect(s1.slug).not.toEqual(s2.slug);
    const row = await testServices().pool.query(`SELECT location_precision FROM shops WHERE id = $1`, [s1.shopId]);
    expect(['city', 'area']).toContain(row.rows[0].location_precision);
  });

  it('validates coverage and publishing prerequisites', async () => {
    const seller = await createUser();
    await createShop(seller.ctx, profile('Coverage Test'));
    await expect(updateDeliveryCoverage(seller.ctx, { ...coverage, scope: 'states', states: '' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(publishShop(seller.ctx)).rejects.toMatchObject({ code: expect.any(String) });
    await updateDeliveryCoverage(seller.ctx, coverage);
    await addOrReplacePayoutAccount(seller.ctx, { bankCode: '058', accountNumber: '0123456789', accountName: 'Test User' });
    const res = await publishShop(seller.ctx);
    expect(res.status).toBe('active');
  });

  it('stores only the last four account digits and applies a cooling-off period on replacement', async () => {
    const seller = await createUser();
    const { shopId } = await createShop(seller.ctx, profile('Payout Test'));
    await addOrReplacePayoutAccount(seller.ctx, { bankCode: '058', accountNumber: '0123456789', accountName: 'Test User' });
    const replaced = await addOrReplacePayoutAccount(seller.ctx, { bankCode: '044', accountNumber: '9876543210', accountName: 'Test User' });
    const rows = await testServices().pool.query(`SELECT * FROM payout_accounts WHERE shop_id = $1 ORDER BY created_at`, [shopId]);
    expect(rows.rows.map((r) => r.status)).toEqual(['replaced', expect.stringMatching(/pending|verified/)]);
    expect(JSON.stringify(rows.rows)).not.toContain('9876543210');
    expect(rows.rows[1].account_number_last4).toBe('3210');
    expect(new Date(rows.rows[1].usable_after).getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect(JSON.stringify(replaced)).not.toContain('9876543210');
  });

  it('verification decisions need a trust & safety role and a reason', async () => {
    const seller = await createUser();
    const { shopId } = await createShop(seller.ctx, profile('Verify Me'));
    const media = await insertMedia(seller.id, 'verification_evidence');
    const { caseId } = await submitVerification(seller.ctx, { legalName: 'Test User', idType: 'nin', idNumberLast4: '1234', evidenceMediaIds: media });
    await expect(submitVerification(seller.ctx, { legalName: 'Test User', idType: 'nin', idNumberLast4: '1234', evidenceMediaIds: media })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const buyer = await createUser();
    await expect(decideVerification(buyer.ctx, { caseId, decision: 'approve', reason: 'Looks fine to me honestly' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const staff = await createUser({ roles: ['trust_safety'] });
    await expect(decideVerification(staff.ctx, { caseId, decision: 'approve', reason: 'short' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await decideVerification(staff.ctx, { caseId, decision: 'approve', reason: 'Document matches the account holder.' });
    const shop = await testServices().pool.query(`SELECT verification_status, verified_at, verification_label FROM shops WHERE id = $1`, [shopId]);
    expect(shop.rows[0].verification_status).toBe('approved');
    expect(shop.rows[0].verification_label).toMatch(/Identity checked/);
    const audit = await testServices().pool.query(`SELECT action FROM audit_events WHERE target_id = $1 ORDER BY id`, [caseId]);
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['verification.submitted']));
  });

  it('draft shops are invisible to others', async () => {
    const seller = await createUser();
    const { slug } = await createShop(seller.ctx, profile('Hidden Draft'));
    const other = await createUser();
    await expect(getShopStorefront(other.ctx, slug)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const own = await getShopStorefront(seller.ctx, slug);
    expect(own.isOwner).toBe(true);
  });
});
