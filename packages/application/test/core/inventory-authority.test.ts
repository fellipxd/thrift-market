import { afterAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@thrift/database';
import { isDomainError } from '@thrift/domain';
import { convertReservation, readStock, releaseReservation, reserveStock, withdrawStock } from '../../src/inventory/authority';
import { closeTestServices, createListing, createUser, testServices } from '../support';

afterAll(closeTestServices);

const inTenMinutes = () => new Date(Date.now() + 10 * 60_000);

describe('inventory authority', () => {
  it('reserves, converts and keeps the stock invariant', async () => {
    const { pool } = testServices();
    const listing = await createListing();
    const buyer = await createUser();
    const r = await withTransaction(pool, (tx) =>
      reserveStock(tx, { listingId: listing.id, buyerUserId: buyer.id, quantity: 1, source: 'checkout', sourceId: null, unitPriceMinor: 850_000, expiresAt: inTenMinutes() }),
    );
    expect((await readStock(pool, listing.id))?.quantityReserved).toBe(1);
    const res = await withTransaction(pool, (tx) => convertReservation(tx, r.id));
    expect(res).toEqual({ converted: true, reallocated: false });
    const stock = await readStock(pool, listing.id);
    expect(stock).toMatchObject({ quantityAvailable: 0, quantityReserved: 0, quantitySold: 1 });
    const again = await withTransaction(pool, (tx) => convertReservation(tx, r.id));
    expect(again.converted).toBe(true);
    expect((await readStock(pool, listing.id))?.quantitySold).toBe(1);
    const status = await pool.query('SELECT status FROM listings WHERE id = $1', [listing.id]);
    expect(status.rows[0].status).toBe('sold');
  });

  it('T01: 100 concurrent attempts on one unique piece allocate exactly one hold', async () => {
    const { pool } = testServices();
    const listing = await createListing();
    const buyers = await Promise.all(Array.from({ length: 20 }, () => createUser()));
    const attempts = Array.from({ length: 100 }, (_, i) =>
      withTransaction(pool, (tx) =>
        reserveStock(tx, {
          listingId: listing.id,
          buyerUserId: buyers[i % buyers.length]!.id,
          quantity: 1,
          source: 'checkout',
          sourceId: null,
          unitPriceMinor: 850_000,
          expiresAt: inTenMinutes(),
        }),
      ).then(
        () => 'won' as const,
        (err) => (isDomainError(err) && err.code === 'STOCK_CONFLICT' ? ('conflict' as const) : Promise.reject(err)),
      ),
    );
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r === 'won')).toHaveLength(1);
    expect(results.filter((r) => r === 'conflict')).toHaveLength(99);
    const active = await pool.query(`SELECT count(*)::int AS n FROM reservations WHERE listing_id = $1 AND status = 'active'`, [listing.id]);
    expect(active.rows[0].n).toBe(1);
    expect(await readStock(pool, listing.id)).toMatchObject({ quantityAvailable: 0, quantityReserved: 1 });
  });

  it('equivalent units: concurrent reservations never exceed quantity', async () => {
    const { pool } = testServices();
    const listing = await createListing({ quantity: 5 });
    const buyer = await createUser();
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, () =>
        withTransaction(pool, (tx) =>
          reserveStock(tx, { listingId: listing.id, buyerUserId: buyer.id, quantity: 1, source: 'checkout', sourceId: null, unitPriceMinor: 100_000, expiresAt: inTenMinutes() }),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    expect(await readStock(pool, listing.id)).toMatchObject({ quantityAvailable: 0, quantityReserved: 5, quantityTotal: 5 });
  });

  it('late payment after release reallocates only when stock is still available', async () => {
    const { pool } = testServices();
    const listing = await createListing();
    const a = await createUser();
    const b = await createUser();
    const ra = await withTransaction(pool, (tx) =>
      reserveStock(tx, { listingId: listing.id, buyerUserId: a.id, quantity: 1, source: 'checkout', sourceId: null, unitPriceMinor: 850_000, expiresAt: inTenMinutes() }),
    );
    await withTransaction(pool, (tx) => releaseReservation(tx, ra.id, { reason: 'test', status: 'expired' }));
    const rb = await withTransaction(pool, (tx) =>
      reserveStock(tx, { listingId: listing.id, buyerUserId: b.id, quantity: 1, source: 'checkout', sourceId: null, unitPriceMinor: 850_000, expiresAt: inTenMinutes() }),
    );
    // A's late payment cannot take the unit now held by B.
    expect(await withTransaction(pool, (tx) => convertReservation(tx, ra.id))).toEqual({ converted: false, reallocated: false });
    await withTransaction(pool, (tx) => releaseReservation(tx, rb.id, { reason: 'test' }));
    // Unit free again: a late verified payment may be reallocated.
    expect(await withTransaction(pool, (tx) => convertReservation(tx, ra.id))).toEqual({ converted: true, reallocated: true });
    expect(await readStock(pool, listing.id)).toMatchObject({ quantitySold: 1, quantityAvailable: 0, quantityReserved: 0 });
  });

  it('withdraw only touches available units', async () => {
    const { pool } = testServices();
    const listing = await createListing({ quantity: 2 });
    const buyer = await createUser();
    await withTransaction(pool, (tx) =>
      reserveStock(tx, { listingId: listing.id, buyerUserId: buyer.id, quantity: 1, source: 'checkout', sourceId: null, unitPriceMinor: 100_000, expiresAt: inTenMinutes() }),
    );
    await withTransaction(pool, (tx) => withdrawStock(tx, { listingId: listing.id, quantity: 1, reason: 'sold elsewhere', actorUserId: listing.shop.owner.id }));
    await expect(
      withTransaction(pool, (tx) => withdrawStock(tx, { listingId: listing.id, quantity: 1, reason: 'sold elsewhere', actorUserId: listing.shop.owner.id })),
    ).rejects.toMatchObject({ code: 'STOCK_CONFLICT' });
  });
});
