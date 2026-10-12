import { DomainError } from '@thrift/domain';
import { many, maybeOne, one, withTransaction } from '@thrift/database';
import { requireOwnShop, requireUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { enqueue } from '../core/outbox';
import { parseInput } from '../core/validation';
import { mediaPath } from '../media/media';
import { batchIdInput, batchInput, updateBatchInput } from './inputs';
import { isUuid } from './internal';
import { LISTING_STATUS_LABEL } from '../shops/queries';

/**
 * Batches group a stock intake or a product drop. Each listing in a batch keeps its own stock row, photos,
 * condition and flaws — a batch never merges distinct pieces into a quantity.
 */

export interface BatchSummary {
  id: string;
  name: string;
  note: string;
  dropAt: string | null;
  dropAnnouncedAt: string | null;
  pieces: number;
  scheduled: number;
  onSale: number;
  createdAt: string;
}

export async function listBatches(ctx: AppContext): Promise<BatchSummary[]> {
  const shop = await requireOwnShop(ctx.pool, ctx);
  const rows = await many<{ id: string; name: string; note: string; drop_at: Date | null; drop_announced_at: Date | null; pieces: number; scheduled: number; on_sale: number; created_at: Date }>(
    ctx.pool,
    `SELECT b.id, b.name, b.note, b.drop_at, b.drop_announced_at, b.created_at,
            count(l.id) FILTER (WHERE l.status <> 'removed')::int AS pieces,
            count(l.id) FILTER (WHERE l.status = 'scheduled')::int AS scheduled,
            count(l.id) FILTER (WHERE l.status IN ('active','reserved'))::int AS on_sale
       FROM batches b LEFT JOIN listings l ON l.batch_id = b.id
      WHERE b.shop_id = $1 GROUP BY b.id ORDER BY b.created_at DESC`,
    [shop.id],
  );
  return rows.map((b) => ({
    id: b.id,
    name: b.name,
    note: b.note,
    dropAt: b.drop_at ? new Date(b.drop_at).toISOString() : null,
    dropAnnouncedAt: b.drop_announced_at ? new Date(b.drop_announced_at).toISOString() : null,
    pieces: b.pieces,
    scheduled: b.scheduled,
    onSale: b.on_sale,
    createdAt: new Date(b.created_at).toISOString(),
  }));
}

export interface BatchDetail extends BatchSummary {
  listings: { id: string; title: string; status: string; statusLabel: string; priceMinor: number | null; photoUrl: string | null; condition: string | null; sizeLabel: string | null }[];
}

export async function getBatch(ctx: AppContext, batchId: string): Promise<BatchDetail> {
  const shop = await requireOwnShop(ctx.pool, ctx);
  if (!isUuid(batchId)) throw new DomainError('NOT_FOUND', 'Batch not found.');
  const all = await listBatches(ctx);
  const b = all.find((x) => x.id === batchId);
  if (!b) throw new DomainError('NOT_FOUND', 'Batch not found.');
  const listings = await many<{ id: string; title: string; status: string; price_minor: number | null; storage_key: string | null; condition: string | null; size_label: string | null }>(
    ctx.pool,
    `SELECT l.id, l.title, l.status, l.price_minor, l.condition, l.size_label,
            (SELECT m.storage_key FROM listing_media lm JOIN media_assets m ON m.id = lm.media_id WHERE lm.listing_id = l.id ORDER BY lm.position LIMIT 1) AS storage_key
       FROM listings l WHERE l.batch_id = $1 AND l.shop_id = $2 AND l.status <> 'removed' ORDER BY l.created_at`,
    [batchId, shop.id],
  );
  return {
    ...b,
    listings: listings.map((l) => ({
      id: l.id,
      title: l.title,
      status: l.status,
      statusLabel: LISTING_STATUS_LABEL[l.status] ?? l.status,
      priceMinor: l.price_minor,
      photoUrl: l.storage_key ? mediaPath(l.storage_key, 'thumb') : null,
      condition: l.condition,
      sizeLabel: l.size_label,
    })),
  };
}

function assertFutureDrop(dropAt: Date | null, now: Date): void {
  if (dropAt && dropAt.getTime() <= now.getTime() + 60_000) {
    throw new DomainError('VALIDATION_FAILED', 'Choose a drop time at least a minute in the future, or leave it empty.', { fieldErrors: { dropAt: 'Choose a future time.' } });
  }
  if (dropAt && dropAt.getTime() > now.getTime() + 60 * 86_400_000) {
    throw new DomainError('VALIDATION_FAILED', 'Drops can be scheduled up to 60 days ahead.', { fieldErrors: { dropAt: 'Too far ahead.' } });
  }
}

export async function createBatch(ctx: AppContext, raw: unknown): Promise<{ batchId: string }> {
  requireUser(ctx);
  const input = parseInput(batchInput, raw);
  const shop = await requireOwnShop(ctx.pool, ctx);
  assertFutureDrop(input.dropAt, ctx.now());
  const count = await one<{ n: number }>(ctx.pool, 'SELECT count(*)::int AS n FROM batches WHERE shop_id = $1', [shop.id]);
  if (count.n >= 500) throw new DomainError('VALIDATION_FAILED', 'You have reached the batch limit. Reuse an existing batch.');
  const b = await one<{ id: string }>(ctx.pool, `INSERT INTO batches (shop_id, name, note, drop_at) VALUES ($1, $2, $3, $4) RETURNING id`, [
    shop.id,
    input.name,
    input.note,
    input.dropAt,
  ]);
  return { batchId: b.id };
}

/**
 * Updates a batch. Once a drop has gone live its time is fixed. Moving or clearing a future drop time updates
 * the status of its scheduled listings (cleared → on sale now).
 */
export async function updateBatch(ctx: AppContext, raw: unknown): Promise<{ batchId: string; released: number }> {
  requireUser(ctx);
  const input = parseInput(updateBatchInput, raw);
  const shop = await requireOwnShop(ctx.pool, ctx);
  return withTransaction(ctx.pool, async (tx) => {
    const b = await maybeOne<{ id: string; drop_at: Date | null; drop_announced_at: Date | null }>(
      tx,
      'SELECT id, drop_at, drop_announced_at FROM batches WHERE id = $1 AND shop_id = $2 FOR UPDATE',
      [input.batchId, shop.id],
    );
    if (!b) throw new DomainError('NOT_FOUND', 'Batch not found.');
    const sameTime = (b.drop_at?.getTime() ?? null) === (input.dropAt?.getTime() ?? null);
    if (b.drop_announced_at && !sameTime) throw new DomainError('INVALID_STATE', 'This drop has already gone live; its time can no longer change.');
    if (!sameTime) assertFutureDrop(input.dropAt, ctx.now());
    await tx.query('UPDATE batches SET name = $2, note = $3, drop_at = $4 WHERE id = $1', [b.id, input.name, input.note, input.dropAt]);
    let released = 0;
    if (!sameTime && !input.dropAt) {
      const res = await tx.query(
        `UPDATE listings SET status = 'active', published_at = now(), updated_at = now() WHERE batch_id = $1 AND status = 'scheduled'`,
        [b.id],
      );
      released = res.rowCount ?? 0;
    }
    return { batchId: b.id, released };
  });
}

export async function deleteBatch(ctx: AppContext, raw: unknown): Promise<{ deleted: boolean }> {
  requireUser(ctx);
  const input = parseInput(batchIdInput, raw);
  const shop = await requireOwnShop(ctx.pool, ctx);
  return withTransaction(ctx.pool, async (tx) => {
    const b = await maybeOne(tx, 'SELECT id FROM batches WHERE id = $1 AND shop_id = $2 FOR UPDATE', [input.batchId, shop.id]);
    if (!b) throw new DomainError('NOT_FOUND', 'Batch not found.');
    const used = await one<{ n: number }>(tx, `SELECT count(*)::int AS n FROM listings WHERE batch_id = $1 AND status <> 'removed'`, [input.batchId]);
    if (used.n > 0) throw new DomainError('INVALID_STATE', 'Move or remove the listings in this batch first.');
    await tx.query('DELETE FROM batches WHERE id = $1', [input.batchId]);
    return { deleted: true };
  });
}

/**
 * Worker task: releases due drops. Scheduled listings in a batch whose drop time has passed go on sale, the
 * drop is marked announced (so it only happens once) and a deduplicated 'batch.dropped' event is enqueued for
 * follower notifications. Safe on several workers (SKIP LOCKED) and after restarts (status guards).
 */
export async function releaseScheduledDrops(ctx: AppContext, batchSize = 20): Promise<{ released: number; batches: number }> {
  let released = 0;
  let batches = 0;
  for (;;) {
    const done = await withTransaction(ctx.pool, async (tx) => {
      const b = await maybeOne<{ id: string; shop_id: string }>(
        tx,
        `SELECT id, shop_id FROM batches
          WHERE drop_at IS NOT NULL AND drop_at <= $1 AND drop_announced_at IS NULL
          ORDER BY drop_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [ctx.now()],
      );
      if (!b) return true;
      const res = await tx.query<{ id: string }>(
        `UPDATE listings l SET status = CASE WHEN coalesce(st.quantity_available, 0) > 0 THEN 'active'
                                             WHEN coalesce(st.quantity_reserved, 0) > 0 THEN 'reserved' ELSE 'ended' END,
                               published_at = now(), updated_at = now()
           FROM inventory_stock st
          WHERE l.batch_id = $1 AND l.status = 'scheduled' AND st.listing_id = l.id
          RETURNING l.id`,
        [b.id],
      );
      await tx.query('UPDATE batches SET drop_announced_at = now() WHERE id = $1', [b.id]);
      for (const row of res.rows) {
        await enqueue(tx, { topic: 'listing.published', aggregateId: row.id, payload: { listingId: row.id, shopId: b.shop_id }, dedupeKey: `listing.published:${row.id}` });
      }
      if ((res.rowCount ?? 0) > 0) {
        await enqueue(tx, {
          topic: 'batch.dropped',
          aggregateId: b.id,
          payload: { batchId: b.id, shopId: b.shop_id, listingCount: res.rowCount },
          dedupeKey: `batch.dropped:${b.id}`,
        });
      }
      released += res.rowCount ?? 0;
      batches++;
      return batches >= batchSize;
    });
    if (done) break;
  }
  return { released, batches };
}
