import { many, type Queryable } from '@thrift/database';

export type NotificationTopic = 'transactional' | 'messages' | 'new_drops' | 'auctions' | 'promotions' | 'digest';

export const NOTIFICATION_TOPICS: readonly NotificationTopic[] = ['transactional', 'messages', 'new_drops', 'auctions', 'promotions', 'digest'];
export const MARKETING_TOPICS: readonly NotificationTopic[] = ['new_drops', 'promotions', 'digest'];
const MARKETING: ReadonlySet<NotificationTopic> = new Set(MARKETING_TOPICS);

export interface NotifyInput {
  userId: string;
  topic: NotificationTopic;
  kind: string;
  title: string;
  body?: string;
  link?: string | null;
  /** Per-user unique key; duplicate events never notify twice. */
  dedupeKey: string;
  /** Appended to email/SMS bodies (e.g. a one-click unsubscribe link for marketing topics). */
  footer?: string;
}

/**
 * Creates an in-app notification and queues external messages on channels the user opted into.
 * Transactional notices always appear in-app. Other activity topics (messages, auctions the user takes part in)
 * appear in-app unless turned off. Marketing topics (drops, promotions, digest) require explicit opt-in on every
 * channel, including in-app. Email/SMS always require explicit opt-in.
 */
export async function notifyUser(db: Queryable, n: NotifyInput): Promise<{ created: boolean }> {
  const prefs = await many<{ channel: 'in_app' | 'email' | 'sms'; opted_in: boolean }>(
    db,
    'SELECT channel, opted_in FROM notification_preferences WHERE user_id = $1 AND topic = $2',
    [n.userId, n.topic],
  );
  const optedIn = (channel: 'in_app' | 'email' | 'sms') => prefs.find((p) => p.channel === channel)?.opted_in ?? false;
  const inApp = n.topic === 'transactional' ? true : MARKETING.has(n.topic) ? optedIn('in_app') : (prefs.find((p) => p.channel === 'in_app')?.opted_in ?? true);
  if (MARKETING.has(n.topic) && !inApp && !optedIn('email') && !optedIn('sms')) return { created: false };
  let created = false;
  if (inApp) {
    const res = await db.query(
      `INSERT INTO notifications (user_id, topic, kind, title, body, link, dedupe_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (user_id, dedupe_key) DO NOTHING`,
      [n.userId, n.topic, n.kind, n.title, n.body ?? '', n.link ?? null, n.dedupeKey],
    );
    created = (res.rowCount ?? 0) > 0;
  }
  for (const channel of ['email', 'sms'] as const) {
    if (!optedIn(channel)) continue;
    const contact = await many<{ email: string | null; phone: string | null; email_verified_at: Date | null; phone_verified_at: Date | null }>(
      db,
      'SELECT email, phone, email_verified_at, phone_verified_at FROM users WHERE id = $1',
      [n.userId],
    );
    const u = contact[0];
    const destination = channel === 'email' ? (u?.email_verified_at ? u.email : null) : u?.phone_verified_at ? u.phone : null;
    if (!destination) continue;
    await db.query(
      `INSERT INTO outbound_messages (user_id, channel, destination, subject, body, kind, dedupe_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (dedupe_key) DO NOTHING`,
      [n.userId, channel, destination, n.title, [n.title, n.body ?? '', n.footer ?? ''].filter(Boolean).join('\n\n'), n.kind, `${channel}:${n.userId}:${n.dedupeKey}`],
    );
  }
  return { created };
}
