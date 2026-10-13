import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actOnReport,
  decideDispute,
  decideRefund,
  escalateOverdueDisputes,
  financeReconciliation,
  markDeliveredBySeller,
  markDispatched,
  openDispute,
  requestStaffRefund,
  submitReport,
} from '../../src';
import { ensureCheckoutReferenceData } from '../checkout/helpers';
import { paidOrder } from '../fulfilment/helpers';
import { closeTestServices, createListing, createUser, systemCtx, testServices } from '../support';

afterAll(closeTestServices);
beforeAll(ensureCheckoutReferenceData);

const pool = () => testServices().pool;
const numberOf = async (orderId: string) => (await pool().query('SELECT number FROM orders WHERE id = $1', [orderId])).rows[0].number as string;
const joinShop = (shopId: string, userId: string) => pool().query(`INSERT INTO shop_members (shop_id, user_id, role) VALUES ($1, $2, 'staff')`, [shopId, userId]);

describe('R23: staff exception refunds and conflicts of interest', () => {
  it('support raises an exception refund by order number; it needs a different finance member, never a party to the order', async () => {
    const o = await paidOrder('seller_arranged');
    const number = await numberOf(o.orderId);
    const support = await createUser({ roles: ['support'], name: 'Support' });
    const finance = await createUser({ roles: ['finance'], name: 'Finance' });
    const financeSeller = await createUser({ roles: ['finance'], name: 'Finance who sells' });
    await joinShop(o.listing.shop.id, financeSeller.id);

    await expect(requestStaffRefund(o.buyer.ctx, { orderNumber: number, amount: '1000', note: 'Goodwill for a late delivery' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(requestStaffRefund(support.ctx, { orderNumber: 'TM999999999', amount: '1000', note: 'Goodwill for a late delivery' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(requestStaffRefund(financeSeller.ctx, { orderNumber: number, amount: '1000', note: 'Goodwill for a late delivery' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const r = await requestStaffRefund(support.ctx, { orderNumber: number.toLowerCase(), amount: '1000', note: 'Goodwill for a late delivery' });
    expect(r.status).toBe('requested');
    await expect(decideRefund(financeSeller.ctx, { refundId: r.refundId, decision: 'approve', reason: 'Fine by me' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await decideRefund(finance.ctx, { refundId: r.refundId, decision: 'approve', reason: 'Agreed with support' })).toMatchObject({ status: 'approved' });

    // The finance member who raised one can't approve their own.
    const own = await requestStaffRefund(finance.ctx, { orderNumber: number, amount: '500', note: 'Second goodwill gesture' });
    await expect(decideRefund(finance.ctx, { refundId: own.refundId, decision: 'approve', reason: 'Approving my own' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('staff can’t decide a dispute on an order they bought or sold, or act on a report they filed or that concerns them', async () => {
    const o = await paidOrder('seller_arranged');
    await markDispatched(o.seller.ctx, { orderId: o.orderId, carrierName: 'Rider' });
    await markDeliveredBySeller(o.seller.ctx, { orderId: o.orderId });
    const { disputeId } = await openDispute(o.buyer.ctx, { orderId: o.orderId, reason: 'undisclosed_defect', description: 'A large stain on the front that was not shown.' });
    await pool().query(`UPDATE disputes SET respond_by = now() - interval '1 minute' WHERE id = $1`, [disputeId]);
    await escalateOverdueDisputes(systemCtx());
    const insider = await createUser({ roles: ['support'], name: 'Support who sells' });
    await joinShop(o.listing.shop.id, insider.id);
    await expect(decideDispute(insider.ctx, { disputeId, outcome: 'no_refund', reason: 'Looks fine to me as the seller' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const neutral = await createUser({ roles: ['support'], name: 'Neutral support' });
    expect(await decideDispute(neutral.ctx, { disputeId, outcome: 'no_refund', reason: 'Photos show the mark was disclosed' })).toMatchObject({ disputeId });

    const ts = await createUser({ roles: ['trust_safety'], name: 'T&S who sells' });
    const listing = await createListing();
    await joinShop(listing.shop.id, ts.id);
    const reporter = await createUser();
    const { reportId } = await submitReport(reporter.ctx, { kind: 'listing', id: listing.id, reason: 'misleading', details: 'Photos look borrowed' });
    await expect(actOnReport(ts.ctx, { reportId, action: 'dismiss', reason: 'Nothing wrong with my listing' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const filer = await createUser({ roles: ['trust_safety'], name: 'T&S reporter' });
    const filed = await submitReport(filer.ctx, { kind: 'listing', id: (await createListing()).id, reason: 'counterfeit', details: 'Fake label' });
    await expect(actOnReport(filer.ctx, { reportId: filed.reportId, action: 'remove_listing', reason: 'I reported it, removing it' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const other = await createUser({ roles: ['trust_safety'], name: 'Other T&S' });
    expect(await actOnReport(other.ctx, { reportId, action: 'dismiss', reason: 'Photos match the piece' })).toMatchObject({ reportId });
  });
});

describe('R23: finance reconciliation', () => {
  it('flags orders marked paid without a confirmed payment, and leaves a normal paid order alone', async () => {
    const good = await paidOrder('seller_arranged');
    const goodNumber = await numberOf(good.orderId);
    const before = await financeReconciliation(pool());
    for (const c of before) expect(c.samples).not.toContain(goodNumber);

    const unpaid = await paidOrder('seller_arranged');
    await pool().query(`UPDATE payment_attempts SET status = 'failed' WHERE order_id = $1`, [unpaid.orderId]);
    const after = await financeReconciliation(pool());
    const drift = after.find((c) => c.key === 'paid_without_payment')!;
    expect(drift.count).toBeGreaterThanOrEqual(1);
    const capture = after.find((c) => c.key === 'capture_without_ledger')!;
    expect(capture.samples).not.toContain(goodNumber);
    expect((await financeReconciliation(pool())).find((c) => c.key === 'paid_without_payment')!.count).toBe(drift.count);
    expect(drift.samples.length).toBeGreaterThan(0);
  });
});
