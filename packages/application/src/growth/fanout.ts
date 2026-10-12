import { formatWat } from '@thrift/domain';
import { many, maybeOne, type Queryable } from '@thrift/database';
import type { AppContext } from '../core/context';
import { notifyUser, type NotificationTopic } from '../notifications/notify';
import { unsubscribeUrl } from './unsubscribe';

/**
 * Followers of a shop who asked for its drops and haven't blocked (or been blocked by) the shop's members.
 * Whether a notice is actually delivered, and on which channels, is decided by notifyUser from their consent.
 */
async function eligibleFollowers(db: Queryable, shopId: string): Promise<string[]> {
  const rows = await many<{ user_id: string }>(
    db,
    `SELECT f.user_id FROM follows f JOIN users u ON u.id = f.user_id
      WHERE f.shop_id = $1 AND f.notify_drops AND u.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM shop_members m WHERE m.shop_id = f.shop_id AND m.user_id = f.user_id)
        AND NOT EXISTS (SELECT 1 FROM user_blocks b JOIN shop_members m ON m.shop_id = f.shop_id
                         WHERE (b.blocker_user_id = f.user_id AND b.blocked_user_id = m.user_id) OR (b.blocked_user_id = f.user_id AND b.blocker_user_id = m.user_id))`,
    [shopId],
  );
  return rows.map((r) => r.user_id);
}

function footer(ctx: AppContext, userId: string, topic: NotificationTopic): string {
  return `Don’t want these emails? Unsubscribe: ${unsubscribeUrl(ctx, { userId, topic, channel: 'email' })}`;
}

/** Outbox 'batch.dropped' → each opted-in follower is notified once per batch (dedupe key), however often the event repeats. */
export async function onBatchDropped(ctx: AppContext, tx: Queryable, payload: { batchId?: string; shopId?: string; listingCount?: number }): Promise<number> {
  if (!payload.batchId) return 0;
  const b = await maybeOne<{ shop_id: string; name: string; shop_name: string; slug: string }>(
    tx,
    `SELECT b.shop_id, b.name, s.name AS shop_name, s.slug FROM batches b JOIN shops s ON s.id = b.shop_id WHERE b.id = $1 AND s.status = 'active'`,
    [payload.batchId],
  );
  if (!b) return 0;
  let created = 0;
  for (const userId of await eligibleFollowers(tx, b.shop_id)) {
    const r = await notifyUser(tx, {
      userId,
      topic: 'new_drops',
      kind: 'drop_released',
      title: `${b.shop_name} just dropped “${b.name}”`,
      body: payload.listingCount ? `${payload.listingCount} new piece${payload.listingCount === 1 ? '' : 's'} — unique items go fast.` : 'New pieces are live.',
      link: `/shops/${b.slug}`,
      dedupeKey: `drop:${payload.batchId}`,
      footer: footer(ctx, userId, 'new_drops'),
    });
    if (r.created) created++;
  }
  return created;
}

/** Outbox 'auction.scheduled' → followers hear about upcoming auctions from shops they follow (once per auction). */
export async function onAuctionScheduled(ctx: AppContext, tx: Queryable, payload: { auctionId?: string; shopId?: string; startsAt?: string }): Promise<number> {
  if (!payload.auctionId || !payload.shopId) return 0;
  const a = await maybeOne<{ title: string; shop_name: string; starts_at: Date }>(
    tx,
    `SELECT l.title, s.name AS shop_name, a.starts_at FROM auctions a JOIN listings l ON l.id = a.listing_id JOIN shops s ON s.id = a.shop_id
      WHERE a.id = $1 AND a.status IN ('scheduled','live') AND s.status = 'active'`,
    [payload.auctionId],
  );
  if (!a) return 0;
  let created = 0;
  for (const userId of await eligibleFollowers(tx, payload.shopId)) {
    const r = await notifyUser(tx, {
      userId,
      topic: 'auctions',
      kind: 'auction_scheduled',
      title: `${a.shop_name} scheduled an auction: “${a.title}”`,
      body: `Bidding opens ${formatWat(a.starts_at)}.`,
      link: `/auctions/${payload.auctionId}`,
      dedupeKey: `auction-scheduled:${payload.auctionId}`,
      footer: footer(ctx, userId, 'auctions'),
    });
    if (r.created) created++;
  }
  return created;
}

/** Daily digest for users who opted in: new pieces from followed shops in the last day. One per user per day. */
export async function followedDigest(ctx: AppContext, batchSize = 500): Promise<{ sent: number }> {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(ctx.now());
  const users = await many<{ user_id: string }>(
    ctx.pool,
    `SELECT DISTINCT p.user_id FROM notification_preferences p JOIN users u ON u.id = p.user_id
      WHERE p.topic = 'digest' AND p.opted_in AND u.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = p.user_id AND n.dedupe_key = $1 || p.user_id::text)
      LIMIT $2`,
    [`digest:${day}:`, batchSize],
  );
  let sent = 0;
  for (const { user_id } of users) {
    const r = await maybeOne<{ n: number; shops: number }>(
      ctx.pool,
      `SELECT count(*)::int AS n, count(DISTINCT l.shop_id)::int AS shops FROM follows f
         JOIN listings l ON l.shop_id = f.shop_id JOIN shops s ON s.id = l.shop_id
        WHERE f.user_id = $1 AND s.status = 'active' AND l.status = 'active' AND l.published_at > $2::timestamptz - interval '1 day'`,
      [user_id, ctx.now()],
    );
    if (!r || r.n === 0) continue;
    const res = await notifyUser(ctx.pool, {
      userId: user_id,
      topic: 'digest',
      kind: 'followed_digest',
      title: `${r.n} new piece${r.n === 1 ? '' : 's'} from ${r.shops} shop${r.shops === 1 ? '' : 's'} you follow`,
      body: 'See what’s new today.',
      link: '/following',
      dedupeKey: `digest:${day}:${user_id}`,
      footer: footer(ctx, user_id, 'digest'),
    });
    if (res.created) sent++;
  }
  return { sent };
}
