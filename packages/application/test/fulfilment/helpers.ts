import { startCheckout } from '../../src';
import { createListing, createUser, systemCtx, testServices, type TestListing, type TestUser } from '../support';
import { addAddress, key, pay } from '../checkout/helpers';

export interface PaidOrder {
  orderId: string;
  listing: TestListing;
  buyer: TestUser;
  seller: TestUser;
}

/** A paid order with the given delivery method (shop in FCT; buyer in Lagos unless collecting). */
export async function paidOrder(method: 'integrated' | 'seller_arranged' | 'pickup' = 'seller_arranged', opts: { listing?: TestListing; state?: string; city?: string } = {}): Promise<PaidOrder> {
  const listing = opts.listing ?? (await createListing({ priceMinor: 900_000 }));
  const buyer = await createUser({ name: 'Buyer' });
  // Pickup is offered to buyers in the shop's own city (test shops are in Abuja).
  const addressId = await addAddress(buyer, method === 'pickup' ? { state: 'FCT', city: 'Abuja' } : { state: opts.state, city: opts.city });
  const started = await startCheckout(buyer.ctx, { listingId: listing.id, addressId, deliveryMethod: method, idempotencyKey: key() });
  await pay(systemCtx(), started.orderId);
  return { orderId: started.orderId, listing, buyer, seller: listing.shop.owner };
}

export async function row(table: 'orders' | 'shipments' | 'payouts', orderId: string): Promise<Record<string, any>> {
  const col = table === 'orders' ? 'id' : 'order_id';
  return (await testServices().pool.query(`SELECT * FROM ${table} WHERE ${col} = $1`, [orderId])).rows[0];
}

export async function insertMediaFor(ownerId: string, purpose: 'delivery_proof' | 'dispute_evidence'): Promise<string> {
  const r = await testServices().pool.query(
    `INSERT INTO media_assets (owner_user_id, purpose, storage_key, mime_type, bytes, sha256, visibility) VALUES ($1, $2, $3, 'image/webp', 10, 'x', 'restricted') RETURNING id`,
    [ownerId, purpose, `${purpose}/test/${key()}`],
  );
  return r.rows[0].id;
}
