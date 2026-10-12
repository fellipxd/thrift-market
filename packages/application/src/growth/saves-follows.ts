import { z } from 'zod';
import { DomainError } from '@thrift/domain';
import { maybeOne, withTransaction } from '@thrift/database';
import { requireUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { enforceRateLimit } from '../core/rate-limit';
import { parseInput } from '../core/validation';

const boolish = z.union([z.boolean(), z.enum(['true', 'false', 'on', '1', '0'])]).transform((v) => v === true || v === 'true' || v === 'on' || v === '1');

const saveInput = z.object({ listingId: z.string().uuid('Item not found.'), saved: boolish });
const followInput = z.object({ shopId: z.string().uuid('Shop not found.'), follow: boolish });

/**
 * Sets the saved state explicitly (idempotent: repeating "save" is a no-op). Only publicly visible listings
 * can be saved. A new save increments today's save count for seller insights.
 */
export async function setSaved(ctx: AppContext, raw: unknown): Promise<{ saved: boolean }> {
  const user = requireUser(ctx);
  const input = parseInput(saveInput, raw);
  await enforceRateLimit(ctx.pool, `save:${user.userId}`, 300, 3600);
  return withTransaction(ctx.pool, async (tx) => {
    if (input.saved) {
      const visible = await maybeOne(
        tx,
        `SELECT 1 AS ok FROM listings l JOIN shops s ON s.id = l.shop_id
          WHERE l.id = $1 AND s.status IN ('active','paused') AND l.status IN ('active','reserved','scheduled','sold')`,
        [input.listingId],
      );
      if (!visible) throw new DomainError('NOT_FOUND', 'This item could not be found.');
      const res = await tx.query(`INSERT INTO saved_items (user_id, listing_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [user.userId, input.listingId]);
      if (res.rowCount) {
        await tx.query(
          `INSERT INTO listing_daily_stats (listing_id, day, saves) VALUES ($1, current_date, 1)
           ON CONFLICT (listing_id, day) DO UPDATE SET saves = listing_daily_stats.saves + 1`,
          [input.listingId],
        );
      }
      return { saved: true };
    }
    await tx.query(`DELETE FROM saved_items WHERE user_id = $1 AND listing_id = $2`, [user.userId, input.listingId]);
    return { saved: false };
  });
}

/**
 * Sets the follow state explicitly. follower_count changes only when a row is actually inserted/deleted, so
 * concurrent or repeated requests keep the count exact. Sellers cannot follow their own shop.
 */
export async function setFollow(ctx: AppContext, raw: unknown): Promise<{ following: boolean; followerCount: number }> {
  const user = requireUser(ctx);
  const input = parseInput(followInput, raw);
  await enforceRateLimit(ctx.pool, `follow:${user.userId}`, 200, 3600);
  return withTransaction(ctx.pool, async (tx) => {
    const shop = await maybeOne<{ id: string; owner_user_id: string; status: string }>(tx, 'SELECT id, owner_user_id, status FROM shops WHERE id = $1', [input.shopId]);
    if (!shop || shop.status === 'draft' || shop.status === 'suspended') throw new DomainError('NOT_FOUND', 'Shop not found.');
    if (input.follow) {
      const member = await maybeOne(tx, 'SELECT 1 AS ok FROM shop_members WHERE shop_id = $1 AND user_id = $2', [shop.id, user.userId]);
      if (member) throw new DomainError('INVALID_STATE', 'You cannot follow your own shop.');
      const res = await tx.query('INSERT INTO follows (user_id, shop_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user.userId, shop.id]);
      if (res.rowCount) await tx.query('UPDATE shops SET follower_count = follower_count + 1 WHERE id = $1', [shop.id]);
    } else {
      const res = await tx.query('DELETE FROM follows WHERE user_id = $1 AND shop_id = $2', [user.userId, shop.id]);
      if (res.rowCount) await tx.query('UPDATE shops SET follower_count = greatest(follower_count - 1, 0) WHERE id = $1', [shop.id]);
    }
    const count = await maybeOne<{ follower_count: number }>(tx, 'SELECT follower_count FROM shops WHERE id = $1', [shop.id]);
    return { following: input.follow, followerCount: count?.follower_count ?? 0 };
  });
}
