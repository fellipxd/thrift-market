import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@thrift/database';
import { isDomainError } from '@thrift/domain';
import { SANDBOX_SIGNATURE_HEADER, signSandboxPayload, type PaymentProvider } from '@thrift/providers';
import {
  applyVerifiedPayment,
  cancelOrderBySeller,
  createPaymentAttempt,
  createRefund,
  decideRefund,
  ingestPaymentWebhook,
  initializePaymentAttempt,
  ledgerBalances,
  processRefunds,
  processWebhookRow,
  refreshPayoutForOrder,
  releasePayouts,
  sellerPayableBalance,
  startCheckout,
  unbalancedLedgerTransactions,
} from '../../src';
import type { AppContext } from '../../src/core/context';
import { closeTestServices, createListing, createShop, createUser, systemCtx, testServices, type TestListing } from '../support';
import { addAddress, ensureCheckoutReferenceData, key, orderRow, pay, referenceFor, setSetting, stock, verifiedPayoutAccount } from './helpers';

afterAll(closeTestServices);
beforeAll(ensureCheckoutReferenceData);

async function count(sql: string, params: unknown[]): Promise<number> {
  const r = await testServices().pool.query(sql, params);
  return Number(r.rows[0].n);
}

/** A buyer starts checkout on a fresh listing (payment still pending). */
async function pendingOrder(opts: { listing?: TestListing; priceMinor?: number } = {}) {
  const listing = opts.listing ?? (await createListing({ priceMinor: opts.priceMinor ?? 500_000 }));
  const buyer = await createUser({ name: 'Buyer' });
  const addressId = await addAddress(buyer);
  const started = await startCheckout(buyer.ctx, { listingId: listing.id, addressId, deliveryMethod: 'seller_arranged', idempotencyKey: key() });
  return { listing, buyer, started, orderId: started.orderId };
}

async function paidOrder(opts: { listing?: TestListing; priceMinor?: number } = {}) {
  const o = await pendingOrder(opts);
  await pay(systemCtx(), o.orderId);
  return o;
}

/** Marks the sandbox provider record paid without delivering any webhook (as if the buyer paid at the provider). */
async function markProviderPaid(reference: string): Promise<void> {
  const store = testServices().sandboxPayments;
  const rec = await store.get(reference);
  await store.put({ ...rec!, status: 'succeeded', paidAt: new Date() });
}

function signedBody(event: 'charge.success' | 'charge.failed', reference: string, id = `evt_${reference}_${event}`) {
  const body = JSON.stringify({ id, event, data: { reference } });
  return { body, headers: { [SANDBOX_SIGNATURE_HEADER]: signSandboxPayload(testServices().config.appSecret, body) } };
}

function withPayments(ctx: AppContext, payments: PaymentProvider): AppContext {
  return { ...ctx, providers: { ...ctx.providers, payments } };
}

describe('T04 payment webhooks', () => {
  it('rejects a forged signature: nothing stored, nothing applied, audit recorded', async () => {
    const { orderId } = await pendingOrder();
    const reference = await referenceFor(orderId);
    await markProviderPaid(reference);
    const body = JSON.stringify({ id: `evt_forged_${reference}`, event: 'charge.success', data: { reference } });
    const res = await ingestPaymentWebhook(systemCtx(), 'sandbox', body, { [SANDBOX_SIGNATURE_HEADER]: 'deadbeef' });
    expect(res).toEqual({ accepted: false, duplicate: false, inboxId: null });
    const res2 = await ingestPaymentWebhook(systemCtx(), 'sandbox', body, {});
    expect(res2.accepted).toBe(false);
    expect(await count(`SELECT count(*) AS n FROM webhook_inbox WHERE payload::text LIKE $1`, [`%${reference}%`])).toBe(0);
    expect((await orderRow(orderId)).payment_status).toBe('pending');
    expect(await count(`SELECT count(*) AS n FROM audit_events WHERE action = 'webhook.signature_rejected'`, [])).toBeGreaterThanOrEqual(2);
  });

  it('rejects a webhook addressed to a provider that is not configured', async () => {
    await expect(ingestPaymentWebhook(systemCtx(), 'paystack', '{}', {})).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('the same webhook delivered 5x concurrently produces one capture, one ledger posting and one payout', async () => {
    const { orderId, listing } = await pendingOrder();
    const reference = await referenceFor(orderId);
    await markProviderPaid(reference);
    const { body, headers } = signedBody('charge.success', reference);
    const ingested = await Promise.all(Array.from({ length: 5 }, () => ingestPaymentWebhook(systemCtx(), 'sandbox', body, headers)));
    expect(ingested.filter((r) => r.accepted)).toHaveLength(5);
    expect(ingested.filter((r) => r.inboxId)).toHaveLength(1);
    // The worker and inline processing race; re-verification is idempotent too.
    const inboxId = ingested.find((r) => r.inboxId)!.inboxId!;
    await Promise.all([
      processWebhookRow(systemCtx(), inboxId),
      processWebhookRow(systemCtx(), inboxId),
      ...Array.from({ length: 4 }, () => applyVerifiedPayment(systemCtx(), reference)),
    ]);
    expect((await orderRow(orderId)).payment_status).toBe('paid');
    expect(await count(`SELECT count(*) AS n FROM ledger_transactions WHERE order_id = $1 AND kind = 'payment_captured'`, [orderId])).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM payouts WHERE order_id = $1`, [orderId])).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM shipments WHERE order_id = $1`, [orderId])).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM outbox_events WHERE dedupe_key = $1`, [`order.paid:${orderId}`])).toBe(1);
    expect(await stock(listing.id)).toMatchObject({ quantity_sold: 1, quantity_reserved: 0 });
    expect(await unbalancedLedgerTransactions(testServices().pool)).toEqual([]);
  });

  it('an out-of-order failure event after success never downgrades the payment', async () => {
    const { orderId } = await paidOrder();
    const reference = await referenceFor(orderId);
    const { body, headers } = signedBody('charge.failed', reference);
    const res = await ingestPaymentWebhook(systemCtx(), 'sandbox', body, headers);
    expect(res.accepted).toBe(true);
    await processWebhookRow(systemCtx(), res.inboxId!);
    const o = await orderRow(orderId);
    expect(o).toMatchObject({ payment_status: 'paid', status: 'confirmed' });
    const attempt = await testServices().pool.query(`SELECT status FROM payment_attempts WHERE reference = $1`, [reference]);
    expect(attempt.rows[0].status).toBe('succeeded');
  });

  it('does not apply a verified payment whose amount does not match the attempt', async () => {
    const { orderId, listing } = await pendingOrder();
    const reference = await referenceFor(orderId);
    // The provider reports a different amount than the attempt asked for.
    await testServices().pool.query(`UPDATE sandbox_payments SET amount_minor = amount_minor - 100, status = 'succeeded', paid_at = now() WHERE reference = $1`, [reference]);
    const result = await applyVerifiedPayment(systemCtx(), reference);
    expect(result.outcome).toBe('mismatch');
    expect((await orderRow(orderId)).payment_status).not.toBe('paid');
    const attempt = await testServices().pool.query(`SELECT status FROM payment_attempts WHERE reference = $1`, [reference]);
    expect(attempt.rows[0].status).toBe('uncertain');
    expect((await stock(listing.id)).quantity_sold).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM ledger_transactions WHERE order_id = $1`, [orderId])).toBe(0);
  });

  it('a second successful payment on an already-paid order is recorded as a duplicate and refunded automatically', async () => {
    const { orderId, buyer } = await paidOrder();
    const { pool } = testServices();
    const order = await orderRow(orderId);
    const attempt = await withTransaction(pool, (tx) => createPaymentAttempt(tx, systemCtx(), { orderId, payerUserId: buyer.id, amountMinor: Number(order.total_minor) }));
    await initializePaymentAttempt(systemCtx(), attempt.id, { callbackPath: `/checkout/return`, description: 'test' });
    await markProviderPaid(attempt.reference);
    const result = await applyVerifiedPayment(systemCtx(), attempt.reference);
    expect(result.outcome).toBe('duplicate_refunded');
    expect((await pool.query(`SELECT status FROM payment_attempts WHERE id = $1`, [attempt.id])).rows[0].status).toBe('duplicate');
    const refund = await pool.query(`SELECT id, status, reason, amount_minor FROM refunds WHERE payment_attempt_id = $1`, [attempt.id]);
    expect(refund.rows[0]).toMatchObject({ status: 'approved', reason: 'duplicate_payment', amount_minor: order.total_minor });
    await processRefunds(systemCtx());
    expect((await pool.query(`SELECT status FROM refunds WHERE id = $1`, [refund.rows[0].id])).rows[0].status).toBe('succeeded');
    // The original sale is untouched.
    expect(await orderRow(orderId)).toMatchObject({ payment_status: 'paid', status: 'confirmed' });
    expect(await count(`SELECT count(*) AS n FROM ledger_transactions WHERE order_id = $1 AND kind = 'payment_captured'`, [orderId])).toBe(2);
    expect(await unbalancedLedgerTransactions(pool)).toEqual([]);
  });
});

describe('refunds', () => {
  it('concurrent refund workers send one provider refund and post one ledger transaction', async () => {
    const { orderId } = await paidOrder();
    const { pool } = testServices();
    const order = await orderRow(orderId);
    const refund = await withTransaction(pool, async (tx) => {
      await tx.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
      return createRefund(tx, systemCtx(), { orderId, amountMinor: Number(order.total_minor), reason: 'not_delivered', autoApprove: true, idempotencyKey: `t:${orderId}` });
    });
    expect((await orderRow(orderId)).payment_status).toBe('refund_pending');

    const base = systemCtx();
    let calls = 0;
    const real = base.providers.payments;
    const spy: PaymentProvider = Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
      refund: async (input: Parameters<PaymentProvider['refund']>[0]) => {
        if (input.reference === (await referenceFor(orderId))) calls++;
        await new Promise((r) => setTimeout(r, 30));
        return real.refund(input);
      },
    });
    const ctx = withPayments(base, spy);
    await Promise.all([processRefunds(ctx), processRefunds(ctx), processRefunds(ctx)]);
    expect(calls).toBe(1);
    expect((await pool.query(`SELECT status FROM refunds WHERE id = $1`, [refund.id])).rows[0].status).toBe('succeeded');
    expect(await count(`SELECT count(*) AS n FROM ledger_transactions WHERE idempotency_key = $1`, [`refund:${refund.id}`])).toBe(1);
    expect(await orderRow(orderId)).toMatchObject({ payment_status: 'refunded', payout_status: 'reversed' });
    expect((await pool.query(`SELECT status FROM payouts WHERE order_id = $1`, [orderId])).rows[0].status).toBe('cancelled');
    expect(await unbalancedLedgerTransactions(pool)).toEqual([]);
  });

  it('cannot refund more than was paid, and a partial refund reduces the held payout', async () => {
    const { orderId, listing } = await paidOrder({ priceMinor: 1_000_000 });
    const { pool } = testServices();
    const order = await orderRow(orderId);
    const total = Number(order.total_minor);
    await expect(
      withTransaction(pool, (tx) => createRefund(tx, systemCtx(), { orderId, amountMinor: total + 1, reason: 'dispute_upheld', autoApprove: true, idempotencyKey: key() })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await withTransaction(pool, (tx) => createRefund(tx, systemCtx(), { orderId, amountMinor: 200_000, reason: 'dispute_upheld', autoApprove: true, idempotencyKey: key() }));
    const before = await sellerPayableBalance(pool, listing.shop.id);
    await processRefunds(systemCtx());
    expect((await orderRow(orderId)).payment_status).toBe('partially_refunded');
    const payout = await pool.query(`SELECT amount_minor, status FROM payouts WHERE order_id = $1`, [orderId]);
    expect(payout.rows[0]).toMatchObject({ status: 'held', amount_minor: total - 200_000 });
    expect(await sellerPayableBalance(pool, listing.shop.id)).toBe(before - 200_000);
    await expect(
      withTransaction(pool, (tx) => createRefund(tx, systemCtx(), { orderId, amountMinor: total - 199_999, reason: 'dispute_upheld', autoApprove: true, idempotencyKey: key() })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('staff-exception refunds need a second finance approver', async () => {
    const { orderId } = await paidOrder();
    const { pool } = testServices();
    const finance1 = await createUser({ roles: ['finance'] });
    const finance2 = await createUser({ roles: ['finance'] });
    const refund = await withTransaction(pool, (tx) =>
      createRefund(tx, finance1.ctx, { orderId, amountMinor: 1_000, reason: 'staff_exception', requestedBy: finance1.id, autoApprove: true, idempotencyKey: key() }),
    );
    expect(refund.status).toBe('requested');
    await expect(decideRefund(finance1.ctx, { refundId: refund.id, decision: 'approve', reason: 'Goodwill for delay' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const buyer = await createUser();
    await expect(decideRefund(buyer.ctx, { refundId: refund.id, decision: 'approve', reason: 'Goodwill for delay' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await decideRefund(finance2.ctx, { refundId: refund.id, decision: 'reject', reason: 'Not covered by policy' });
    expect((await orderRow(orderId)).payment_status).toBe('paid');
  });
});

describe('T12 payouts', () => {
  async function deliver(orderId: string, confidence: 'seller_reported' | 'courier_verified' | 'buyer_confirmed' | 'staff_verified') {
    const { pool } = testServices();
    await pool.query(`UPDATE shipments SET status = 'delivered', confidence = $2, delivered_at = now() - interval '1 hour' WHERE order_id = $1`, [orderId, confidence]);
    await pool.query(`UPDATE orders SET fulfilment_status = 'delivered', buyer_confirmed_at = CASE WHEN $2 = 'buyer_confirmed' THEN now() ELSE NULL END WHERE id = $1`, [
      orderId,
      confidence,
    ]);
  }
  async function refresh(orderId: string) {
    return withTransaction(testServices().pool, async (tx) => {
      await tx.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
      return refreshPayoutForOrder(tx, systemCtx(), orderId);
    });
  }

  it('seller-reported delivery never makes a payout eligible; buyer confirmation does', async () => {
    const { orderId } = await paidOrder();
    expect(await refresh(orderId)).toBe('held');
    await deliver(orderId, 'seller_reported');
    expect(await refresh(orderId)).toBe('held');
    const held = await testServices().pool.query(`SELECT hold_reason FROM payouts WHERE order_id = $1`, [orderId]);
    expect(held.rows[0].hold_reason).toBe('awaiting_buyer_confirmation');
    await deliver(orderId, 'buyer_confirmed');
    expect(await refresh(orderId)).toBe('eligible');
    expect((await orderRow(orderId)).payout_status).toBe('eligible');
  });

  it('courier-verified delivery becomes eligible after the configured delay; an open dispute blocks it', async () => {
    await setSetting('payout_release_hours_after_courier_delivery', 48);
    const { orderId } = await paidOrder();
    await deliver(orderId, 'courier_verified');
    expect(await refresh(orderId)).toBe('eligible');
    const p = await testServices().pool.query(`SELECT eligible_at FROM payouts WHERE order_id = $1`, [orderId]);
    expect(new Date(p.rows[0].eligible_at).getTime()).toBeGreaterThan(Date.now() + 46 * 3600_000);
    await testServices().pool.query(`UPDATE orders SET dispute_status = 'open' WHERE id = $1`, [orderId]);
    expect(await refresh(orderId)).toBe('blocked');
    await testServices().pool.query(`UPDATE orders SET dispute_status = 'resolved' WHERE id = $1`, [orderId]);
    expect(await refresh(orderId)).toBe('eligible');
  });

  it('releases only to a verified payout account past its cooling-off period, posts the ledger and completes the order', async () => {
    await setSetting('payout_release_hours_after_confirmation', 0);
    const shopNoAccount = await createShop();
    const shopCooling = await createShop();
    const shopReady = await createShop();
    await verifiedPayoutAccount(shopCooling.id, shopCooling.owner.id, new Date(Date.now() + 24 * 3600_000));
    await verifiedPayoutAccount(shopReady.id, shopReady.owner.id);
    const a = await paidOrder({ listing: await createListing({ shop: shopNoAccount }) });
    const b = await paidOrder({ listing: await createListing({ shop: shopCooling }) });
    const c = await paidOrder({ listing: await createListing({ shop: shopReady }) });
    for (const o of [a, b, c]) {
      await deliver(o.orderId, 'buyer_confirmed');
      expect(await refresh(o.orderId)).toBe('eligible');
    }
    const { pool } = testServices();
    const beforeReady = await sellerPayableBalance(pool, shopReady.id);
    const result = await releasePayouts(systemCtx(), 100);
    expect(result.paid).toBeGreaterThanOrEqual(1);
    const status = async (orderId: string) => (await pool.query(`SELECT status FROM payouts WHERE order_id = $1`, [orderId])).rows[0].status;
    expect(await status(a.orderId)).toBe('eligible');
    expect(await status(b.orderId)).toBe('eligible');
    expect(await status(c.orderId)).toBe('paid');
    expect(await orderRow(c.orderId)).toMatchObject({ status: 'completed', payout_status: 'released' });
    const payoutAmount = Number((await pool.query(`SELECT amount_minor FROM payouts WHERE order_id = $1`, [c.orderId])).rows[0].amount_minor);
    expect(await sellerPayableBalance(pool, shopReady.id)).toBe(beforeReady - payoutAmount);
    // Running the release again is a no-op for the paid payout.
    await releasePayouts(systemCtx(), 100);
    expect(await count(`SELECT count(*) AS n FROM ledger_transactions WHERE order_id = $1 AND kind = 'payout_released'`, [c.orderId])).toBe(1);
    expect(await unbalancedLedgerTransactions(pool)).toEqual([]);
    const balances = await ledgerBalances(pool);
    expect(balances.reduce((s, b) => s + b.balanceMinor, 0)).toBe(0);
  });
});

describe('seller cancellation before dispatch', () => {
  it('cancels, restocks, refunds in full and records the cancellation against the shop', async () => {
    const { orderId, listing, buyer } = await paidOrder();
    await expect(cancelOrderBySeller(buyer.ctx, { orderId, reason: 'Item was damaged in storage', restock: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(cancelOrderBySeller(listing.shop.owner.ctx, { orderId, reason: 'short', restock: true })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const res = await cancelOrderBySeller(listing.shop.owner.ctx, { orderId, reason: 'Item was damaged in storage', restock: false });
    expect(await orderRow(orderId)).toMatchObject({ status: 'cancelled', fulfilment_status: 'cancelled', payment_status: 'refund_pending', payout_status: 'reversed' });
    expect(await stock(listing.id)).toMatchObject({ quantity_sold: 0, quantity_available: 0, quantity_withdrawn: 1 });
    const { pool } = testServices();
    expect(await count(`SELECT count(*) AS n FROM order_events WHERE order_id = $1 AND kind = 'seller_cancelled'`, [orderId])).toBe(1);
    await processRefunds(systemCtx());
    expect((await pool.query(`SELECT status FROM refunds WHERE id = $1`, [res.refundId])).rows[0].status).toBe('succeeded');
    expect((await orderRow(orderId)).payment_status).toBe('refunded');
    expect(await unbalancedLedgerTransactions(pool)).toEqual([]);
    // Cannot cancel twice.
    const again = await cancelOrderBySeller(listing.shop.owner.ctx, { orderId, reason: 'Item was damaged in storage', restock: true }).catch((e) => e);
    expect(isDomainError(again) && again.code).toBe('INVALID_STATE');
  });

  it('restocks when the seller can still sell the piece', async () => {
    const { orderId, listing } = await paidOrder();
    await cancelOrderBySeller(listing.shop.owner.ctx, { orderId, reason: 'Buyer asked me to cancel by phone', restock: true });
    expect(await stock(listing.id)).toMatchObject({ quantity_sold: 0, quantity_available: 1 });
    const l = await testServices().pool.query(`SELECT status FROM listings WHERE id = $1`, [listing.id]);
    expect(l.rows[0].status).toBe('active');
  });
});
