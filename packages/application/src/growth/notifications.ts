import { followDropsInput, notificationIdInput } from '@thrift/contracts';
import { DomainError } from '@thrift/domain';
import { many, maybeOne, one, withTransaction } from '@thrift/database';
import { requireUser } from '../core/authz';
import type { AppContext } from '../core/context';
import { parseInput } from '../core/validation';
import { MARKETING_TOPICS, NOTIFICATION_TOPICS, type NotificationTopic } from '../notifications/notify';

export interface NotificationView {
  id: string;
  topic: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  read: boolean;
  createdAt: string;
}

/** The caller's notifications: unread first, then newest. */
export async function listNotifications(ctx: AppContext, opts: { offset?: number } = {}): Promise<{ items: NotificationView[]; unread: number; nextOffset: number | null }> {
  const user = requireUser(ctx);
  const offset = Math.max(0, Math.min(5000, opts.offset ?? 0));
  const rows = await many<{ id: string; topic: string; kind: string; title: string; body: string; link: string | null; read_at: Date | null; created_at: Date }>(
    ctx.pool,
    `SELECT id, topic, kind, title, body, link, read_at, created_at FROM notifications WHERE user_id = $1
      ORDER BY (read_at IS NULL) DESC, created_at DESC LIMIT 51 OFFSET $2`,
    [user.userId, offset],
  );
  return {
    items: rows.slice(0, 50).map((r) => ({
      id: r.id,
      topic: r.topic,
      kind: r.kind,
      title: r.title,
      body: r.body,
      link: r.link && r.link.startsWith('/') && !r.link.startsWith('//') ? r.link : null,
      read: r.read_at !== null,
      createdAt: new Date(r.created_at).toISOString(),
    })),
    unread: await unreadNotificationCount(ctx),
    nextOffset: rows.length > 50 ? offset + 50 : null,
  };
}

export async function unreadNotificationCount(ctx: AppContext): Promise<number> {
  if (ctx.actor.kind !== 'user') return 0;
  return (await one<{ n: number }>(ctx.pool, 'SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [ctx.actor.userId])).n;
}

export async function markNotificationRead(ctx: AppContext, raw: unknown): Promise<{ link: string | null }> {
  const user = requireUser(ctx);
  const input = parseInput(notificationIdInput, raw);
  const r = await maybeOne<{ link: string | null }>(
    ctx.pool,
    `UPDATE notifications SET read_at = coalesce(read_at, now()) WHERE id = $1 AND user_id = $2 RETURNING link`,
    [input.notificationId, user.userId],
  );
  if (!r) throw new DomainError('NOT_FOUND', 'Notification not found.');
  return { link: r.link && r.link.startsWith('/') && !r.link.startsWith('//') ? r.link : null };
}

export async function markAllNotificationsRead(ctx: AppContext): Promise<{ updated: number }> {
  const user = requireUser(ctx);
  const r = await ctx.pool.query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [user.userId]);
  return { updated: r.rowCount ?? 0 };
}

export type Channel = 'in_app' | 'email' | 'sms';
export const CHANNELS: readonly Channel[] = ['in_app', 'email', 'sms'];

export const TOPIC_INFO: Record<NotificationTopic, { label: string; description: string }> = {
  transactional: { label: 'Orders and account', description: 'Payments, delivery, refunds, disputes and security. In-app notices are always on.' },
  messages: { label: 'Messages and offers', description: 'New chat messages and offer replies.' },
  auctions: { label: 'Auctions you take part in', description: 'Outbid alerts, wins, and auctions from shops you follow.' },
  new_drops: { label: 'New drops from shops you follow', description: 'When a followed shop releases a batch.' },
  promotions: { label: 'Promotions', description: 'Occasional offers from Thrift Market.' },
  digest: { label: 'Daily digest', description: 'One summary a day of new pieces from shops you follow.' },
};

export interface PreferenceCell {
  topic: NotificationTopic;
  channel: Channel;
  on: boolean;
  locked: boolean;
  consentedAt: string | null;
}

export interface NotificationPreferences {
  topics: { topic: NotificationTopic; label: string; description: string; marketing: boolean; cells: PreferenceCell[] }[];
  follows: { shopId: string; shopName: string; shopSlug: string; notifyDrops: boolean }[];
  contacts: { emailVerified: boolean; phoneVerified: boolean };
}

/** Effective defaults mirror notifyUser: transactional in-app locked on; other activity in-app on; marketing and email/SMS off until opted in. */
function defaultOn(topic: NotificationTopic, channel: Channel): boolean {
  if (channel !== 'in_app') return false;
  return !MARKETING_TOPICS.includes(topic);
}

export async function getNotificationPreferences(ctx: AppContext): Promise<NotificationPreferences> {
  const user = requireUser(ctx);
  const rows = await many<{ topic: NotificationTopic; channel: Channel; opted_in: boolean; consented_at: Date | null }>(
    ctx.pool,
    'SELECT topic, channel, opted_in, consented_at FROM notification_preferences WHERE user_id = $1',
    [user.userId],
  );
  const follows = await many<{ shop_id: string; name: string; slug: string; notify_drops: boolean }>(
    ctx.pool,
    `SELECT f.shop_id, s.name, s.slug, f.notify_drops FROM follows f JOIN shops s ON s.id = f.shop_id WHERE f.user_id = $1 ORDER BY s.name`,
    [user.userId],
  );
  const contact = await one<{ email_verified_at: Date | null; phone_verified_at: Date | null }>(ctx.pool, 'SELECT email_verified_at, phone_verified_at FROM users WHERE id = $1', [user.userId]);
  return {
    topics: NOTIFICATION_TOPICS.map((topic) => ({
      topic,
      ...TOPIC_INFO[topic],
      marketing: MARKETING_TOPICS.includes(topic),
      cells: CHANNELS.map((channel) => {
        const row = rows.find((r) => r.topic === topic && r.channel === channel);
        const locked = topic === 'transactional' && channel === 'in_app';
        return { topic, channel, on: locked ? true : (row?.opted_in ?? defaultOn(topic, channel)), locked, consentedAt: row?.consented_at ? new Date(row.consented_at).toISOString() : null };
      }),
    })),
    follows: follows.map((f) => ({ shopId: f.shop_id, shopName: f.name, shopSlug: f.slug, notifyDrops: f.notify_drops })),
    contacts: { emailVerified: contact.email_verified_at !== null, phoneVerified: contact.phone_verified_at !== null },
  };
}

/**
 * Saves the preference matrix. Form fields are `pref:<topic>:<channel>` checkboxes (present = on). Turning a channel
 * on records consent time and source; transactional in-app cannot be turned off.
 */
export async function updateNotificationPreferences(ctx: AppContext, raw: Record<string, unknown>, source = 'settings'): Promise<{ saved: number }> {
  const user = requireUser(ctx);
  let saved = 0;
  await withTransaction(ctx.pool, async (tx) => {
    for (const topic of NOTIFICATION_TOPICS) {
      for (const channel of CHANNELS) {
        if (topic === 'transactional' && channel === 'in_app') continue;
        const on = raw[`pref:${topic}:${channel}`] === 'on' || raw[`pref:${topic}:${channel}`] === true;
        await tx.query(
          `INSERT INTO notification_preferences (user_id, topic, channel, opted_in, consented_at, source, updated_at)
           VALUES ($1, $2, $3, $4, CASE WHEN $4 THEN now() ELSE NULL END, $5, now())
           ON CONFLICT (user_id, topic, channel) DO UPDATE SET
             opted_in = EXCLUDED.opted_in,
             consented_at = CASE WHEN EXCLUDED.opted_in AND NOT notification_preferences.opted_in THEN now()
                                 WHEN EXCLUDED.opted_in THEN notification_preferences.consented_at ELSE NULL END,
             source = EXCLUDED.source, updated_at = now()
           WHERE notification_preferences.opted_in IS DISTINCT FROM EXCLUDED.opted_in`,
          [user.userId, topic, channel, on, source],
        );
        saved++;
      }
    }
  });
  return { saved };
}

/** Per-followed-shop drop notifications toggle. */
export async function setFollowDrops(ctx: AppContext, raw: unknown): Promise<{ notifyDrops: boolean }> {
  const user = requireUser(ctx);
  const input = parseInput(followDropsInput, raw);
  const r = await maybeOne<{ notify_drops: boolean }>(ctx.pool, `UPDATE follows SET notify_drops = $3 WHERE user_id = $1 AND shop_id = $2 RETURNING notify_drops`, [
    user.userId,
    input.shopId,
    input.notifyDrops,
  ]);
  if (!r) throw new DomainError('NOT_FOUND', 'You don’t follow this shop.');
  return { notifyDrops: r.notify_drops };
}
