import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@thrift/database';
import { isDomainError } from '@thrift/domain';
import {
  bulkListingAction,
  createBatch,
  createDraft,
  dispatchOutbox,
  editPublishedListing,
  getListingDetail,
  getListingForEdit,
  markSoldElsewhere,
  pauseListing,
  publishListing,
  publishSchemaVersion,
  releaseScheduledDrops,
  reserveStock,
  restockListing,
  resumeListing,
  setFollow,
  setListingPhotos,
  setSaved,
  updateDraft,
  addFlaw,
} from '../../src';
import { closeTestServices, createShop, createUser, ctxFor, ensureCategory, guestCtx, testServices, type TestShop } from '../support';
import { insertMedia } from './helpers';

afterAll(closeTestServices);

let shop: TestShop;
let categoryId: string;

beforeAll(async () => {
  shop = await createShop();
  ({ categoryId } = await ensureCategory());
});

async function readyDraft(opts: { saleMode?: 'fixed' | 'negotiable' | 'auction'; price?: string; minOffer?: string; quantityMode?: 'unique' | 'equivalent'; quantity?: string; batchId?: string } = {}) {
  const ctx = shop.owner.ctx;
  const { listingId } = await createDraft(ctx, { categoryId, saleMode: opts.saleMode ?? 'fixed', title: 'Relaxed linen shirt' });
  await updateDraft(ctx, {
    listingId,
    description: 'Breathable linen.',
    sizeSystem: 'uk',
    sizeLabel: '12',
    condition: 'good',
    flawsDeclaration: 'none_known',
    price: opts.saleMode === 'auction' ? '' : (opts.price ?? '8500'),
    minOffer: opts.minOffer ?? '',
    quantityMode: opts.quantityMode ?? 'unique',
    quantity: opts.quantity ?? '1',
    ...(opts.batchId ? { batchId: opts.batchId } : {}),
  });
  const m1 = await insertMedia(shop.owner.id);
  const m2 = await insertMedia(shop.owner.id);
  await setListingPhotos(ctx, { listingId, photos: [{ mediaId: m1, role: 'front' }, { mediaId: m2, role: 'back' }] });
  return { listingId, photos: [m1, m2] };
}

describe('listing lifecycle', () => {
  it('publishes a complete draft through the inventory authority and writes version 1', async () => {
    const { listingId } = await readyDraft();
    const res = await publishListing(shop.owner.ctx, { listingId });
    expect(res.status).toBe('active');
    const { pool } = testServices();
    const stock = await pool.query('SELECT * FROM inventory_stock WHERE listing_id = $1', [listingId]);
    expect(stock.rows[0]).toMatchObject({ quantity_total: 1, quantity_available: 1 });
    const versions = await pool.query('SELECT version, snapshot FROM listing_versions WHERE listing_id = $1', [listingId]);
    expect(versions.rows).toHaveLength(1);
    expect(versions.rows[0].snapshot.condition).toBe('good');
    // Pause → resume → mark sold elsewhere
    expect((await pauseListing(shop.owner.ctx, { listingId })).status).toBe('paused');
    expect((await resumeListing(shop.owner.ctx, { listingId })).status).toBe('active');
    expect((await markSoldElsewhere(shop.owner.ctx, { listingId })).status).toBe('ended');
  });

  it('blocks publishing until the checklist passes', async () => {
    const { listingId } = await createDraft(shop.owner.ctx, { categoryId, saleMode: 'fixed', title: 'Incomplete piece' });
    const err = await publishListing(shop.owner.ctx, { listingId }).catch((e) => e);
    expect(err.code).toBe('VALIDATION_FAILED');
    const fields = (err.details.issues as { field: string }[]).map((i) => i.field);
    expect(fields).toEqual(expect.arrayContaining(['photos', 'condition', 'flaws', 'size', 'price']));
  });

  it('requires a photo for every described flaw and disallows "visibly worn" with no flaws', async () => {
    const { listingId } = await readyDraft();
    await addFlaw(shop.owner.ctx, { listingId, description: 'Small stain on hem', severity: 'minor' });
    let err = await publishListing(shop.owner.ctx, { listingId }).catch((e) => e);
    expect((err.details.issues as { field: string }[]).map((i) => i.field)).toContain('flaws.0');
    const { listingId: worn } = await readyDraft();
    await updateDraft(shop.owner.ctx, { listingId: worn, condition: 'worn' });
    err = await publishListing(shop.owner.ctx, { listingId: worn }).catch((e) => e);
    expect((err.details.issues as { field: string }[]).map((i) => i.field)).toContain('flaws');
  });

  it('auction pieces are published by scheduling the auction', async () => {
    const { listingId } = await readyDraft({ saleMode: 'auction' });
    const err = await publishListing(shop.owner.ctx, { listingId }).catch((e) => e);
    expect(err.code).toBe('INVALID_STATE');
    expect(err.details.action).toBe('schedule_auction');
  });

  it('restricts edits while a buyer holds a reservation', async () => {
    const { listingId } = await readyDraft();
    await publishListing(shop.owner.ctx, { listingId });
    const buyer = await createUser();
    await withTransaction(testServices().pool, (tx) =>
      reserveStock(tx, { listingId, buyerUserId: buyer.id, quantity: 1, source: 'checkout', sourceId: null, unitPriceMinor: 850_000, expiresAt: new Date(Date.now() + 600_000) }),
    );
    await expect(editPublishedListing(shop.owner.ctx, { listingId, price: '9000' })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    // Descriptive text can still be corrected; it writes a new version.
    const r = await editPublishedListing(shop.owner.ctx, { listingId, description: 'Breathable linen, corrected.' });
    expect(r.version).toBe(2);
    await expect(pauseListing(shop.owner.ctx, { listingId })).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('identical units restock and withdraw through the inventory authority', async () => {
    const { listingId } = await readyDraft({ quantityMode: 'equivalent', quantity: '3', price: '3500' });
    await publishListing(shop.owner.ctx, { listingId });
    await restockListing(shop.owner.ctx, { listingId, quantity: '2' });
    const r = await markSoldElsewhere(shop.owner.ctx, { listingId, quantity: '4' });
    expect(r.quantityAvailable).toBe(1);
    const unique = await readyDraft();
    await publishListing(shop.owner.ctx, { listingId: unique.listingId });
    await expect(restockListing(shop.owner.ctx, { listingId: unique.listingId, quantity: '1' })).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});

describe('isolation and privacy', () => {
  it('other sellers cannot read or change a seller’s listings (NOT_FOUND)', async () => {
    const { listingId } = await readyDraft();
    const other = await createShop();
    const ctx = other.owner.ctx;
    await expect(getListingForEdit(ctx, listingId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(updateDraft(ctx, { listingId, title: 'Hijacked' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(publishListing(ctx, { listingId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const bulk = await bulkListingAction(ctx, { action: 'pause', listingIds: [listingId] });
    expect(bulk.results[0]).toMatchObject({ ok: false, message: 'Not found.' });
    // Drafts are invisible on the public item page.
    await expect(getListingDetail(guestCtx(), listingId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('the public item page never exposes the private minimum offer', async () => {
    const { listingId } = await readyDraft({ saleMode: 'negotiable', price: '8500', minOffer: '7123' });
    await publishListing(shop.owner.ctx, { listingId });
    const detail = await getListingDetail(guestCtx(), listingId);
    const json = JSON.stringify(detail);
    expect(json).not.toContain('712300');
    expect(json).not.toMatch(/minOffer|min_offer/);
    expect(detail.saleMode).toBe('negotiable');
    // The owner's editor does show it.
    const edit = await getListingForEdit(shop.owner.ctx, listingId);
    expect(edit.minOfferMinor).toBe(712_300);
  });
});

describe('schemas, batches and drops', () => {
  it('old listings keep rendering with their original schema version', async () => {
    const { listingId } = await readyDraft();
    await publishListing(shop.owner.ctx, { listingId });
    const admin = await createUser({ roles: ['admin'] });
    const before = await testServices().pool.query('SELECT schema_version_id FROM listings WHERE id = $1', [listingId]);
    await publishSchemaVersion(admin.ctx, {
      categoryId,
      schema: { sizeRequired: true, allowedSizeSystems: ['eu'], measurements: [{ key: 'chest_cm', label: 'Chest (cm)', required: true }], recommendedPhotoRoles: ['front'], attributes: [] },
    });
    const after = await testServices().pool.query('SELECT schema_version_id FROM listings WHERE id = $1', [listingId]);
    expect(after.rows[0].schema_version_id).toBe(before.rows[0].schema_version_id);
    const detail = await getListingDetail(guestCtx(), listingId);
    expect(detail.size.systemLabel).toBe('UK');
    // Restore a permissive schema for the remaining tests.
    await publishSchemaVersion(admin.ctx, {
      categoryId,
      schema: { sizeRequired: true, allowedSizeSystems: ['uk', 'intl_letter'], measurements: [], recommendedPhotoRoles: ['front', 'back'], attributes: [] },
    });
  });

  it('distinct pieces in one batch keep separate stock rows', async () => {
    const { batchId } = await createBatch(shop.owner.ctx, { name: 'Intake 12', note: '', dropAt: '' });
    const a = await readyDraft({ batchId });
    const b = await readyDraft({ batchId });
    await publishListing(shop.owner.ctx, { listingId: a.listingId });
    await publishListing(shop.owner.ctx, { listingId: b.listingId });
    const rows = await testServices().pool.query('SELECT listing_id, quantity_total FROM inventory_stock WHERE listing_id = ANY($1::uuid[])', [[a.listingId, b.listingId]]);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((r) => r.quantity_total === 1)).toBe(true);
  });

  it('scheduled drops go live once and emit one deduplicated event', async () => {
    const dropAt = new Date(Date.now() + 3_600_000);
    const { batchId } = await createBatch(shop.owner.ctx, { name: 'Friday drop', note: '', dropAt: dropAt.toISOString() });
    const { listingId } = await readyDraft({ batchId });
    expect((await publishListing(shop.owner.ctx, { listingId })).status).toBe('scheduled');
    const later = () => new Date(dropAt.getTime() + 60_000);
    const sys = ctxFor({ kind: 'system', name: 'test' }, later);
    const [r1, r2] = await Promise.all([releaseScheduledDrops(sys), releaseScheduledDrops(sys)]);
    expect(r1.released + r2.released).toBe(1);
    await releaseScheduledDrops(sys);
    const { pool } = testServices();
    expect((await pool.query('SELECT status FROM listings WHERE id = $1', [listingId])).rows[0].status).toBe('active');
    const ev = await pool.query(`SELECT count(*)::int AS n FROM outbox_events WHERE dedupe_key = $1`, [`batch.dropped:${batchId}`]);
    expect(ev.rows[0].n).toBe(1);
    await dispatchOutbox(sys);
  });
});

describe('saves and follows', () => {
  it('follower count stays exact under concurrent and repeated follows', async () => {
    const target = await createShop();
    const users = await Promise.all(Array.from({ length: 10 }, () => createUser()));
    await Promise.all(users.flatMap((u) => [setFollow(u.ctx, { shopId: target.id, follow: true }), setFollow(u.ctx, { shopId: target.id, follow: 'true' })]));
    const { pool } = testServices();
    expect((await pool.query('SELECT follower_count FROM shops WHERE id = $1', [target.id])).rows[0].follower_count).toBe(10);
    await setFollow(users[0]!.ctx, { shopId: target.id, follow: false });
    await setFollow(users[0]!.ctx, { shopId: target.id, follow: false });
    expect((await pool.query('SELECT follower_count FROM shops WHERE id = $1', [target.id])).rows[0].follower_count).toBe(9);
    await expect(setFollow(target.owner.ctx, { shopId: target.id, follow: true })).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('saving is idempotent and only for visible listings', async () => {
    const { listingId } = await readyDraft();
    const buyer = await createUser();
    await expect(setSaved(buyer.ctx, { listingId, saved: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await publishListing(shop.owner.ctx, { listingId });
    await setSaved(buyer.ctx, { listingId, saved: true });
    await setSaved(buyer.ctx, { listingId, saved: true });
    const detail = await getListingDetail(buyer.ctx, listingId);
    expect(detail.saved).toBe(true);
    expect(detail.saveCount).toBe(1);
  });

  it('isDomainError helper is used consistently', () => {
    expect(isDomainError(new Error('x'))).toBe(false);
  });
});
