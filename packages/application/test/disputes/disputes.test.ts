import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addDisputeEntry,
  appealDispute,
  confirmReceipt,
  confirmReturnReceived,
  decideDispute,
  escalateOverdueDisputes,
  markDeliveredBySeller,
  markDispatched,
  openDispute,
  orderDisputeState,
  processRefunds,
  respondToDispute,
  respondToPartialOffer,
  simulateCourierEvent,
  staffDisputeDetail,
  staffDisputeQueue,
  withdrawDispute,
} from '../../src';
import { closeTestServices, createUser, ctxFor, systemCtx, testServices, type TestUser } from '../support';
import { ensureCheckoutReferenceData } from '../checkout/helpers';
import { insertMediaFor, paidOrder, row, type PaidOrder } from '../fulfilment/helpers';

afterAll(closeTestServices);
beforeAll(ensureCheckoutReferenceData);

const pool = () => testServices().pool;
const DAY = 86_400_000;

async function delivered(): Promise<PaidOrder> {
  const o = await paidOrder('seller_arranged');
  await markDispatched(o.seller.ctx, { orderId: o.orderId, carrierName: 'Rider' });
  await markDeliveredBySeller(o.seller.ctx, { orderId: o.orderId });
  return o;
}

async function open(o: PaidOrder, reason = 'undisclosed_defect', evidence: string[] = []) {
  return openDispute(o.buyer.ctx, { orderId: o.orderId, reason, description: 'There is a large stain on the front that was not shown.', evidenceMediaIds: evidence.join(',') });
}

const staff = (roles: ('support' | 'trust_safety')[] = ['support']) => createUser({ roles, name: 'Support' });
const at = (u: TestUser, ms: number) => ctxFor(u.actor, () => new Date(ms));

describe('opening disputes', () => {
  it('enforces reason windows with server time', async () => {
    const shipped = await paidOrder('integrated');
    const { trackingReference } = await markDispatched(shipped.seller.ctx, { orderId: shipped.orderId });
    // Not delivered: not yet — still within the expected window.
    await expect(open(shipped, 'not_delivered')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(open(shipped, 'undisclosed_defect')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    // A courier exception allows it straight away.
    await simulateCourierEvent(systemCtx(), { reference: trackingReference!, status: 'exception' });
    await open(shipped, 'not_delivered');

    const late = await paidOrder('seller_arranged');
    await markDispatched(late.seller.ctx, { orderId: late.orderId, carrierName: 'Rider' });
    await expect(openDispute(at(late.buyer, Date.now() + 30 * DAY), { orderId: late.orderId, reason: 'not_delivered', description: 'Nothing has arrived after a month.' })).resolves.toBeTruthy();

    const d = await delivered();
    await expect(openDispute(at(d.buyer, Date.now() + 10 * DAY), { orderId: d.orderId, reason: 'wrong_item', description: 'This is not the item in the photos.' })).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    const state = await orderDisputeState(d.buyer.ctx, d.orderId);
    expect(state.eligibility?.reasons.map((r) => r.value)).toEqual(['not_delivered', 'undisclosed_defect', 'wrong_item', 'transit_damage', 'other']);
  });

  it('freezes the payout, allows one active dispute, checks evidence ownership and hides it from strangers', async () => {
    const o = await delivered();
    const stranger = await createUser();
    await expect(openDispute(stranger.ctx, { orderId: o.orderId, reason: 'other', description: 'Something is wrong here.' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(open(o, 'undisclosed_defect', [await insertMediaFor(stranger.id, 'dispute_evidence')])).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const evidence = await insertMediaFor(o.buyer.id, 'dispute_evidence');
    const { disputeId } = await open(o, 'undisclosed_defect', [evidence]);
    expect((await row('payouts', o.orderId)).status).toBe('blocked');
    expect((await row('orders', o.orderId)).dispute_status).toBe('open');
    await expect(open(o, 'other')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(confirmReceipt(o.buyer.ctx, { orderId: o.orderId })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(orderDisputeState(stranger.ctx, o.orderId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const sellerView = await orderDisputeState(o.seller.ctx, o.orderId);
    expect(sellerView.dispute?.id).toBe(disputeId);
    expect(sellerView.dispute?.entries[0]?.photos[0]?.url).toMatch(/sig=/);
    expect(sellerView.actions.canRespond).toBe(true);
  });
});

describe('resolution paths', () => {
  it('seller accepts a full refund: one refund through payments, payout cancelled', async () => {
    const o = await delivered();
    const { disputeId } = await open(o);
    await respondToDispute(o.seller.ctx, { disputeId, response: 'accept_full_refund' });
    await expect(respondToDispute(o.seller.ctx, { disputeId, response: 'accept_full_refund' })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const refunds = (await pool().query(`SELECT amount_minor, reason, status FROM refunds WHERE order_id = $1`, [o.orderId])).rows;
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ reason: 'dispute_upheld', status: 'approved' });
    await processRefunds(systemCtx());
    expect(await row('orders', o.orderId)).toMatchObject({ payment_status: 'refunded', dispute_status: 'resolved' });
    expect((await row('payouts', o.orderId)).status).toBe('cancelled');
  });

  it('partial offers are bounded by what was paid; the buyer accepts and the payout is reduced', async () => {
    const o = await delivered();
    const { disputeId } = await open(o);
    const total = Number((await row('orders', o.orderId)).total_minor);
    await expect(respondToDispute(o.seller.ctx, { disputeId, response: 'offer_partial_refund', amount: String(total / 100 + 1) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await respondToDispute(o.seller.ctx, { disputeId, response: 'offer_partial_refund', amount: '2000', message: 'Sorry about the stain' });
    await expect(respondToPartialOffer(o.seller.ctx, { disputeId, decision: 'accept' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await respondToPartialOffer(o.buyer.ctx, { disputeId, decision: 'accept' });
    await processRefunds(systemCtx());
    expect(await row('orders', o.orderId)).toMatchObject({ payment_status: 'partially_refunded', dispute_status: 'resolved' });
    const payout = await row('payouts', o.orderId);
    expect(payout.status).toBe('held');
    expect(Number(payout.amount_minor)).toBe(total - 200_000);
  });

  it('seller rejects → support decides no refund → appeal decided by a different staff member', async () => {
    const o = await delivered();
    const { disputeId } = await open(o);
    await respondToDispute(o.seller.ctx, { disputeId, response: 'reject', message: 'The stain is shown in photo 4 of the listing.' });
    const s1 = await staff();
    const s2 = await staff(['trust_safety']);
    await expect(decideDispute(o.seller.ctx, { disputeId, outcome: 'no_refund', reason: 'Seller decides their own case' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await staffDisputeQueue(s1.ctx)).map((d) => d.id)).toContain(disputeId);
    await addDisputeEntry(s1.ctx, { disputeId, body: 'Photo 4 does show a mark — compare sizes.', internal: true });
    expect((await orderDisputeState(o.buyer.ctx, o.orderId)).dispute?.entries.some((e) => e.internal || e.body.includes('Photo 4 does'))).toBe(false);
    await expect(addDisputeEntry(o.buyer.ctx, { disputeId, body: 'internal?', internal: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await decideDispute(s1.ctx, { disputeId, outcome: 'no_refund', reason: 'The flaw was disclosed in the purchased listing photos.' });
    expect(await row('orders', o.orderId)).toMatchObject({ dispute_status: 'resolved' });
    expect((await row('payouts', o.orderId)).status).toBe('held');

    await appealDispute(o.buyer.ctx, { disputeId, reason: 'The disclosed mark is much smaller than the stain.' });
    expect((await row('payouts', o.orderId)).status).toBe('blocked');
    await expect(appealDispute(o.buyer.ctx, { disputeId, reason: 'Appealing a second time.' })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(decideDispute(s1.ctx, { disputeId, outcome: 'partial_refund', refundAmount: '1500', reason: 'Reconsidered the size' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await decideDispute(s2.ctx, { disputeId, outcome: 'partial_refund', refundAmount: '1500', reason: 'Stain is larger than disclosed; partial refund.' });
    const refunds = (await pool().query(`SELECT amount_minor FROM refunds WHERE order_id = $1`, [o.orderId])).rows;
    expect(refunds.map((r) => Number(r.amount_minor))).toEqual([150_000]);
    await expect(appealDispute(o.seller.ctx, { disputeId, reason: 'Appeal again after the appeal.' })).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('appeals close after the appeal window', async () => {
    const o = await delivered();
    const { disputeId } = await open(o);
    await respondToDispute(o.seller.ctx, { disputeId, response: 'reject', message: 'The item was as described in every photo.' });
    await decideDispute((await staff()).ctx, { disputeId, outcome: 'no_refund', reason: 'Evidence matches the purchased listing.' });
    await expect(appealDispute(at(o.buyer, Date.now() + 8 * DAY), { disputeId, reason: 'I disagree with this outcome.' })).rejects.toMatchObject({ code: 'EXPIRED' });
  });

  it('return and refund: refund only after the seller confirms the return', async () => {
    const o = await delivered();
    const { disputeId } = await open(o, 'wrong_item');
    await respondToDispute(o.seller.ctx, { disputeId, response: 'reject', message: 'I sent the right item, please check again.' });
    const s = await staff();
    await decideDispute(s.ctx, { disputeId, outcome: 'return_and_refund', reason: 'Photos show a different garment.', returnInstructions: 'Return via GIG to the seller’s shop address.' });
    expect((await pool().query(`SELECT count(*)::int AS n FROM refunds WHERE order_id = $1`, [o.orderId])).rows[0].n).toBe(0);
    expect((await row('orders', o.orderId)).dispute_status).toBe('open');
    await expect(confirmReturnReceived(o.buyer.ctx, { disputeId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await confirmReturnReceived(o.seller.ctx, { disputeId });
    await expect(confirmReturnReceived(o.seller.ctx, { disputeId })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect((await pool().query(`SELECT count(*)::int AS n FROM refunds WHERE order_id = $1`, [o.orderId])).rows[0].n).toBe(1);
    expect(await row('orders', o.orderId)).toMatchObject({ dispute_status: 'resolved', fulfilment_status: 'returned' });
  });

  it('overdue seller responses escalate to support; the buyer can withdraw and the hold lifts', async () => {
    const o = await delivered();
    const { disputeId } = await open(o);
    await pool().query(`UPDATE disputes SET respond_by = now() - interval '1 minute' WHERE id = $1`, [disputeId]);
    await escalateOverdueDisputes(systemCtx());
    await escalateOverdueDisputes(systemCtx());
    expect((await pool().query('SELECT status FROM disputes WHERE id = $1', [disputeId])).rows[0].status).toBe('under_review');
    await withdrawDispute(o.buyer.ctx, { disputeId });
    expect(await row('orders', o.orderId)).toMatchObject({ dispute_status: 'resolved' });
    expect((await row('payouts', o.orderId)).status).toBe('held');
  });
});

describe('T10 purchased snapshot', () => {
  it('staff see the listing as purchased even after the seller edits it', async () => {
    const o = await delivered();
    const original = (await pool().query(`SELECT snapshot FROM order_items WHERE order_id = $1`, [o.orderId])).rows[0].snapshot;
    // The seller edits the listing after the sale.
    await pool().query(`UPDATE listings SET title = 'Edited title after sale', condition = 'excellent', version = version + 1 WHERE id = $1`, [o.listing.id]);
    await pool().query(`INSERT INTO listing_versions (listing_id, version, snapshot) VALUES ($1, 2, '{"title":"Edited title after sale"}')`, [o.listing.id]);
    const { disputeId } = await open(o);
    const s = await staff();
    const detail = await staffDisputeDetail(s.ctx, disputeId);
    expect(detail.purchased[0]).toMatchObject({ title: original.title, conditionLabel: original.conditionLabel, currentTitle: 'Edited title after sale', editedAfterPurchase: true });
    await expect(staffDisputeDetail(o.buyer.ctx, disputeId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
