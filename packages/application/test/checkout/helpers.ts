import { one } from '@thrift/database';
import { seedCourierRoutes, seedPolicies, seedSettings } from '../../src/seed/base';
import { simulateSandboxPayment } from '../../src/payments/webhooks';
import { clearSettingsCache } from '../../src/core/settings';
import { testServices, type TestUser } from '../support';

export async function ensureCheckoutReferenceData(): Promise<void> {
  const pool = testServices().pool;
  await seedSettings(pool);
  await seedPolicies(pool);
  await seedCourierRoutes(pool);
  clearSettingsCache();
}

export async function addAddress(user: TestUser, opts: { state?: string; city?: string } = {}): Promise<string> {
  const r = await one<{ id: string }>(
    testServices().pool,
    `INSERT INTO addresses (user_id, recipient_name, phone, line1, city, state, is_default) VALUES ($1, 'Test Buyer', '+2348031234567', '12 Test Street', $2, $3, true) RETURNING id`,
    [user.id, opts.city ?? 'Lagos', opts.state ?? 'Lagos'],
  );
  return r.id;
}

export async function referenceFor(orderId: string): Promise<string> {
  const r = await one<{ reference: string }>(testServices().pool, `SELECT reference FROM payment_attempts WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`, [orderId]);
  return r.reference;
}

/** Buyer completes / fails payment on the sandbox provider's hosted page (delivers a signed webhook). */
export async function pay(ctx: Parameters<typeof simulateSandboxPayment>[0], orderId: string, outcome: 'succeeded' | 'failed' | 'abandoned' = 'succeeded'): Promise<string> {
  const reference = await referenceFor(orderId);
  await simulateSandboxPayment(ctx, { reference, outcome }, testServices().sandboxPayments as never);
  return reference;
}

export async function orderRow(orderId: string): Promise<Record<string, unknown>> {
  return one(testServices().pool, 'SELECT * FROM orders WHERE id = $1', [orderId]);
}

export async function stock(listingId: string): Promise<{ quantity_available: number; quantity_reserved: number; quantity_sold: number; quantity_withdrawn: number }> {
  return one(testServices().pool, 'SELECT quantity_available, quantity_reserved, quantity_sold, quantity_withdrawn FROM inventory_stock WHERE listing_id = $1', [listingId]);
}

let keySeq = 0;
export function key(prefix = 'k'): string {
  keySeq++;
  return `${prefix}_${Date.now().toString(36)}_${keySeq}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function setSetting(name: string, value: number): Promise<void> {
  await testServices().pool.query(`INSERT INTO platform_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [name, JSON.stringify(value)]);
  clearSettingsCache();
}

export async function verifiedPayoutAccount(shopId: string, ownerId: string, usableAfter = new Date(Date.now() - 1000)): Promise<void> {
  await testServices().pool.query(
    `INSERT INTO payout_accounts (shop_id, bank_code, bank_name, account_number_last4, account_name, provider_recipient_code, status, created_by, usable_after)
     VALUES ($1, '058', 'Sandbox Bank', '1234', 'Seller', 'RCP_test', 'verified', $2, $3)`,
    [shopId, ownerId, usableAfter],
  );
}
